from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterator, Sequence


@dataclass(frozen=True)
class TileSelection:
    """Analysis helper for viewer tile selections."""

    selection: dict[str, Any]
    coverage: dict[str, Any]

    @classmethod
    def from_selection(cls, selection: dict[str, Any] | None) -> "TileSelection | None":
        if selection is None:
            return None
        if selection.get("selectionType") != "tiles":
            raise ValueError(f"Expected a tile selection, got {selection.get('selectionType')!r}.")
        coverage = selection.get("tiles", {}).get("coverage")
        if not isinstance(coverage, dict):
            raise ValueError("Tile selection is missing tiles.coverage.")
        return cls(selection=selection, coverage=coverage)

    @property
    def dataset_id(self) -> str | None:
        return self.selection.get("datasetId")

    @property
    def layer_id(self) -> str | None:
        return self.selection.get("layerId")

    @property
    def tile_count(self) -> int:
        return int(self.coverage.get("tileCount", 0))

    @property
    def range_count(self) -> int:
        return int(self.coverage.get("rangeCount", 0))

    @property
    def order(self) -> int | None:
        value = self.coverage.get("order")
        return int(value) if value is not None else None

    def tile_ranges(self) -> list[dict[str, Any]]:
        return [dict(row) for row in self.coverage.get("tileRanges", [])]

    def iter_tiles(self) -> Iterator[dict[str, int]]:
        for row in self.coverage.get("tileRanges", []):
            for x in range(int(row["x0"]), int(row["x1"]) + 1):
                yield {
                    "order": int(row["order"]),
                    "face": int(row["face"]),
                    "x": x,
                    "y": int(row["y"]),
                }

    def cell_ranges(self, *, order: int | None = None) -> list[dict[str, Any]]:
        rows = []
        for row in self.coverage.get("cellRanges", []):
            rows.append(_convert_cell_range(row, order))
        return rows

    def iter_cells(self, *, order: int | None = None, max_cells: int = 1_000_000) -> Iterator[tuple[int, int, int]]:
        rows = self.cell_ranges(order=order)
        total = sum(int(row["cellCount"]) for row in rows)
        if max_cells is not None and total > max_cells:
            raise ValueError(f"Selection expands to {total} cells; raise max_cells to iterate explicitly.")
        for row in rows:
            face = int(row["face"])
            for iy in range(int(row["iy0"]), int(row["iy1"]) + 1):
                for ix in range(int(row["ix0"]), int(row["ix1"]) + 1):
                    yield face, ix, iy

    def nested_id_ranges(self, *, order: int | None = None) -> list[dict[str, Any]]:
        target_order = self._target_order(order)
        ranges = []
        for tile in self.iter_tiles():
            tile_order = int(tile["order"])
            if target_order < tile_order:
                raise ValueError("nested_id_ranges(order=...) must use order >= the selected tile order.")
            scale_order = target_order - tile_order
            tile_shift = int(self.coverage["tileShift"]) + scale_order
            tile_size = 2**tile_shift
            ix0 = int(tile["x"]) * tile_size
            iy0 = int(tile["y"]) * tile_size
            start = int(tile["face"]) * 4**target_order + _morton_encode(ix0, iy0, target_order)
            count = 4**tile_shift
            ranges.append(
                {
                    "order": target_order,
                    "face": int(tile["face"]),
                    "start": start,
                    "stop": start + count,
                    "count": count,
                    "tile": tile,
                }
            )
        return ranges

    def values_from_nested(
        self,
        array: Sequence[Any],
        *,
        order: int | None = None,
        concatenate: bool = True,
    ) -> Any:
        target_order = order if order is not None else _infer_order_from_full_sky_length(len(array))
        chunks = [array[row["start"] : row["stop"]] for row in self.nested_id_ranges(order=target_order)]
        if not concatenate:
            return chunks
        try:
            import numpy as np
        except ImportError as error:
            raise ImportError("values_from_nested(..., concatenate=True) requires numpy.") from error
        return np.concatenate(chunks)

    def values_from_face_cell(
        self,
        array: Sequence[Any],
        *,
        order: int | None = None,
        prefix: Sequence[Any] = (),
        concatenate: bool = True,
    ) -> Any:
        """Return selected values from a block/cell array with block_order=0."""

        return self.values_from_block_cell(
            array,
            order=order,
            block_order=0,
            prefix=prefix,
            concatenate=concatenate,
        )

    def values_from_block_cell(
        self,
        array: Sequence[Any],
        *,
        order: int | None = None,
        block_order: int,
        prefix: Sequence[Any] = (),
        concatenate: bool = True,
    ) -> Any:
        """Return selected values from an array shaped (..., block, cell)."""

        target_order = self._target_order(order)
        block_order = int(block_order)
        if block_order < 0:
            raise ValueError("block_order must be non-negative.")
        if block_order > target_order:
            raise ValueError("block_order must be <= order.")
        block_cell_count = 4 ** (target_order - block_order)
        prefix_tuple = tuple(prefix)
        chunks = []
        for row in self.nested_id_ranges(order=target_order):
            start = int(row["start"])
            stop = int(row["stop"])
            first_block = start // block_cell_count
            last_block = (stop - 1) // block_cell_count
            for block in range(first_block, last_block + 1):
                local_start = max(start - block * block_cell_count, 0)
                local_stop = min(stop - block * block_cell_count, block_cell_count)
                try:
                    chunks.append(array[prefix_tuple + (block, slice(local_start, local_stop))])  # type: ignore[index]
                except TypeError:
                    if prefix_tuple:
                        raise
                    chunks.append(array[block][local_start:local_stop])
        if not concatenate:
            return chunks
        try:
            import numpy as np
        except ImportError as error:
            raise ImportError("values_from_block_cell(..., concatenate=True) requires numpy.") from error
        return np.concatenate(chunks)

    def to_dataframe(self, kind: str = "cell_ranges", *, order: int | None = None) -> Any:
        try:
            import pandas as pd
        except ImportError as error:
            raise ImportError("TileSelection.to_dataframe() requires pandas.") from error
        if kind == "cell_ranges":
            return pd.DataFrame(self.cell_ranges(order=order))
        if kind == "tile_ranges":
            return pd.DataFrame(self.tile_ranges())
        if kind == "tiles":
            return pd.DataFrame(list(self.iter_tiles()))
        if kind == "nested_ranges":
            return pd.DataFrame(self.nested_id_ranges(order=order))
        raise ValueError("kind must be one of: cell_ranges, tile_ranges, tiles, nested_ranges.")

    def _target_order(self, order: int | None) -> int:
        if order is not None:
            return int(order)
        coverage_order = self.order
        if coverage_order is None:
            orders = [int(tile["order"]) for tile in self.iter_tiles()]
            if not orders:
                raise ValueError("Tile selection is empty.")
            if len(set(orders)) != 1:
                raise ValueError("Selection has multiple orders; pass order= explicitly.")
            return orders[0]
        return coverage_order


def _convert_cell_range(row: dict[str, Any], order: int | None) -> dict[str, Any]:
    result = dict(row)
    base_order = int(row["order"])
    if order is None or int(order) == base_order:
        return result
    target_order = int(order)
    if target_order > base_order:
        scale = 2 ** (target_order - base_order)
        result.update(
            {
                "order": target_order,
                "ix0": int(row["ix0"]) * scale,
                "ix1": (int(row["ix1"]) + 1) * scale - 1,
                "iy0": int(row["iy0"]) * scale,
                "iy1": (int(row["iy1"]) + 1) * scale - 1,
                "cellCount": int(row["cellCount"]) * scale * scale,
                "exact": True,
            }
        )
        return result
    scale = 2 ** (base_order - target_order)
    result.update(
        {
            "order": target_order,
            "ix0": int(row["ix0"]) // scale,
            "ix1": int(row["ix1"]) // scale,
            "iy0": int(row["iy0"]) // scale,
            "iy1": int(row["iy1"]) // scale,
            "cellCount": ((int(row["ix1"]) // scale) - (int(row["ix0"]) // scale) + 1)
            * ((int(row["iy1"]) // scale) - (int(row["iy0"]) // scale) + 1),
            "exact": False,
        }
    )
    return result


def _morton_encode(ix: int, iy: int, order: int) -> int:
    code = 0
    for bit in range(order):
        code |= ((ix >> bit) & 1) << (2 * bit)
        code |= ((iy >> bit) & 1) << (2 * bit + 1)
    return code


def _infer_order_from_full_sky_length(length: int) -> int:
    if length % 12 != 0:
        raise ValueError("Cannot infer HEALPix order: full-sky nested array length must be 12 * 4**order.")
    local = length // 12
    order = 0
    while local > 1 and local % 4 == 0:
        local //= 4
        order += 1
    if local != 1:
        raise ValueError("Cannot infer HEALPix order from array length.")
    return order
