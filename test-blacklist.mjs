import 'dotenv/config';
import { isBlacklistedByTether } from './src/api/trongrid.js';

// Known blacklisted USDT TRC20 addresses (public OFAC/Tether lists)
const addresses = [
  process.argv[2] ?? 'TChBBNHqcmYE5pGMGBVqn45CREzQHn7kKy', // test address from user
  'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7', // normal address for comparison
];

for (const addr of addresses) {
  process.env.LOG_LEVEL = 'debug'; // show raw response
  const result = await isBlacklistedByTether(addr);
  console.log(`\n${addr}\n→ blacklisted: ${result}\n`);
}
