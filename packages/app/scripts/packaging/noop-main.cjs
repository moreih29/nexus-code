const { app } = require("electron");

app.whenReady().then(() => {
  if (process.env.NEXUS_NOOP_MAIN_EXIT_IMMEDIATELY !== "0") {
    app.quit();
  }
});
