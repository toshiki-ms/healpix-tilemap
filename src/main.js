import { App } from "./ui/app.js";

const app = new App();
app.start().catch((error) => {
  console.error(error);
  const status = document.querySelector("#datasetStatus");
  if (status) {
    status.textContent = error instanceof Error ? error.message : String(error);
  }
});
