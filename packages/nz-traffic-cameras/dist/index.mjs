// src/index.ts
import { setLiveSnapshot } from "@wwv-seeders/shared";
var NZTA_API_URL = "https://trafficnz.info/service/traffic/rest/4/cameras/all";
var index_default = {
  name: "nz-traffic-cameras",
  cron: "*/5 * * * *",
  // Every 5 minutes
  async fn() {
    var _a;
    try {
      const response = await fetch(NZTA_API_URL, {
        headers: {
          "Accept": "application/json",
          "User-Agent": "WorldWideView-DataEngine"
        }
      });
      if (!response.ok) {
        throw new Error(`Failed to fetch from NZTA: ${response.status}`);
      }
      const data = await response.json();
      const cameras = ((_a = data == null ? void 0 : data.response) == null ? void 0 : _a.camera) || [];
      const entities = cameras.map((cam) => ({
        id: `nzta-cam-${cam.id}`,
        pluginId: "nz-traffic-cameras",
        latitude: cam.latitude,
        longitude: cam.longitude,
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        label: cam.name,
        properties: {
          description: cam.description,
          direction: cam.direction,
          imageUrl: `https://trafficnz.info${cam.imageUrl}`,
          isOffline: cam.offline,
          underMaintenance: cam.underMaintenance
        }
      }));
      await setLiveSnapshot("nz-traffic-cameras", entities, 300);
      console.log(`[NZ Traffic Cameras] Seeded ${entities.length} cameras`);
    } catch (error) {
      console.error("[NZ Traffic Cameras] Seeder Error:", error);
    }
  }
};
export {
  index_default as default
};
