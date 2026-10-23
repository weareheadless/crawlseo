import { loadEnvConfig } from "@next/env";
import { db } from "@/lib/db";
import { measurePendingDeliveryOutcomes } from "@/lib/delivery/outcomes";

loadEnvConfig(process.cwd());

async function main() {
  const results = await measurePendingDeliveryOutcomes();
  console.log(JSON.stringify(results, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
