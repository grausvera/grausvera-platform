const [suite, owner] = process.argv.slice(2);

if (!suite || !owner) {
  process.stderr.write("Pending suite metadata is incomplete.\n");
  process.exit(2);
}

process.stderr.write(`${suite} is PENDING until ${owner} implements its first capability.\n`);
process.exit(2);
