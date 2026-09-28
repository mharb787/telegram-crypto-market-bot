import {
  closeRiskDb,
  inspectRiskDb,
  migrateLegacyRiskDb,
  queryLocalRiskForAddress,
  riskDbPaths,
} from '../src/crawler/riskDb.js';

try {
  const result = migrateLegacyRiskDb({ backup: true });
  const health = inspectRiskDb();
  const sample = health.sampleAddress ? await queryLocalRiskForAddress(health.sampleAddress) : null;
  console.log(JSON.stringify({
    ...result,
    verified: {
      ...health,
      sampleDirectEdges: sample?.directEdges?.length ?? 0,
    },
    paths: riskDbPaths(),
  }, null, 2));
} finally {
  closeRiskDb();
}
