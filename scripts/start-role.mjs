import { spawn } from "node:child_process";

const commands = {
  web: ["npm", ["run", "start", "--workspace", "@grausvera/web"]],
  worker: ["node", ["apps/worker/dist/index.js"]],
};
const role = process.env.APP_ROLE;
const command = commands[role];

if (!command) {
  process.stderr.write("APP_ROLE must be web or worker.\n");
  process.exit(2);
}

const child = spawn(command[0], command[1], { stdio: "inherit" });

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => child.kill(signal));
}

child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
