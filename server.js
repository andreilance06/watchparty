const os = require("os");
const { createApplication } = require("./server/application");

const app = createApplication();
app.listen().then(({ port }) => {
  console.log(`WatchParty running at http://localhost:${port}`);
  try {
    const addresses = Object.values(os.networkInterfaces()).flat()
      .filter((item) => item && item.family === "IPv4" && !item.internal);
    for (const address of addresses) console.log(`LAN: http://${address.address}:${port}`);
  } catch { console.log("LAN: use this computer's IPv4 address with port " + port); }
}).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

function shutdown() {
  app.close().then(() => process.exit(0)).catch(() => process.exit(1));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
