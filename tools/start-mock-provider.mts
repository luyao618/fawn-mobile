import { startMockCompatibleServer } from "../tests/fixtures/providers/mockCompatibleServer.ts";

const port = Number.parseInt(process.env.SLICE0_MOCK_PORT ?? "43117", 10);
const server = await startMockCompatibleServer(port);
console.log(JSON.stringify({ mock_provider: server.baseUrl, profiles: ["profile-a", "profile-b", "abort"] }));

const close = async () => {
  await server.close();
  process.exit(0);
};
process.on("SIGINT", close);
process.on("SIGTERM", close);
