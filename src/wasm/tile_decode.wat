(module
  (memory (export "memory") 8)

  (func (export "decode_u16")
    (param $src i32)
    (param $dst i32)
    (param $count i32)
    (param $scale f32)
    (param $offset f32)
    (param $nodata i32)
    (result i32)
    (local $i i32)
    (local $valid i32)
    (local $encoded i32)

    (block $exit
      (loop $loop
        (br_if $exit (i32.ge_u (local.get $i) (local.get $count)))
        (local.set $encoded
          (i32.load16_u
            (i32.add (local.get $src) (i32.mul (local.get $i) (i32.const 2)))))
        (if (i32.eq (local.get $encoded) (local.get $nodata))
          (then
            (f32.store
              (i32.add (local.get $dst) (i32.mul (local.get $i) (i32.const 4)))
              (f32.const nan)))
          (else
            (f32.store
              (i32.add (local.get $dst) (i32.mul (local.get $i) (i32.const 4)))
              (f32.add
                (f32.mul (f32.convert_i32_u (local.get $encoded)) (local.get $scale))
                (local.get $offset)))
            (local.set $valid (i32.add (local.get $valid) (i32.const 1)))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)))
    (local.get $valid))

  (func (export "decode_i16")
    (param $src i32)
    (param $dst i32)
    (param $count i32)
    (param $scale f32)
    (param $offset f32)
    (param $nodata i32)
    (result i32)
    (local $i i32)
    (local $valid i32)
    (local $encoded i32)

    (block $exit
      (loop $loop
        (br_if $exit (i32.ge_u (local.get $i) (local.get $count)))
        (local.set $encoded
          (i32.load16_s
            (i32.add (local.get $src) (i32.mul (local.get $i) (i32.const 2)))))
        (if (i32.eq (local.get $encoded) (local.get $nodata))
          (then
            (f32.store
              (i32.add (local.get $dst) (i32.mul (local.get $i) (i32.const 4)))
              (f32.const nan)))
          (else
            (f32.store
              (i32.add (local.get $dst) (i32.mul (local.get $i) (i32.const 4)))
              (f32.add
                (f32.mul (f32.convert_i32_s (local.get $encoded)) (local.get $scale))
                (local.get $offset)))
            (local.set $valid (i32.add (local.get $valid) (i32.const 1)))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)))
    (local.get $valid)))
