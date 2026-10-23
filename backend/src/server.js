const { app } = require("./app");
const { env } = require("./core");
const { startWorker } = require("./queue");
const { startCron } = require("./cron");

const port = Number(process.env.PORT || 4000);
app.listen(port, () =>
  console.log(
    `OnboardIQ API on :${port} (extraction provider: ${env.EXTRACTION_PROVIDER})`,
  ),
);
if (process.env.RUN_WORKER !== "false") startWorker();
startCron();
