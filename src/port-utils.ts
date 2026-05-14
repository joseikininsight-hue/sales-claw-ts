// Port utilities — 利用可能な TCP ポートを探す
import * as net from 'net';

export async function isPortAvailable(port: number, host: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const tester = net.createServer();

    tester.once('error', () => resolve(false));
    tester.once('listening', () => {
      tester.close(() => resolve(true));
    });

    tester.listen(port, host);
  });
}

export async function findAvailablePort(
  preferredPort: number | undefined,
  host: string,
  maxAttempts = 20
): Promise<number> {
  const basePort = Number.isInteger(preferredPort) && preferredPort! > 0 ? preferredPort! : 3765;

  for (let candidate = basePort; candidate < basePort + maxAttempts; candidate += 1) {
    if (await isPortAvailable(candidate, host)) return candidate;
  }

  return 0;
}

module.exports = {
  findAvailablePort,
  isPortAvailable,
};
