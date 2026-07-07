import { createWriteStream } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { InstallService } from './service';
import {
  Downloader,
  InstallError,
  Registry,
  RegistryArtifact,
} from './types';

export interface RunInstallDeps {
  readonly registry: Registry;
  readonly downloader: Downloader;
  readonly installDir: string;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
}

/**
 * Downloader por defecto basado en `fetch` (Node >= 18) con streaming a disco,
 * para no bufferizar binarios grandes en memoria.
 */
export function createHttpDownloader(): Downloader {
  return {
    async download(url: string, destPath: string): Promise<void> {
      const response = await fetch(url);
      if (!response.ok || response.body === null) {
        throw new Error(
          `HTTP ${response.status} ${response.statusText} al descargar ${url}`,
        );
      }
      const webStream = response.body as unknown as WebReadableStream<Uint8Array>;
      await pipeline(Readable.fromWeb(webStream), createWriteStream(destPath));
    },
  };
}

/**
 * Registry por defecto que resuelve un manifest JSON por convención de rutas:
 * `${baseUrl}/${name}/${version}/${platform}-${arch}.json`.
 */
export function createHttpRegistry(baseUrl: string): Registry {
  const root = baseUrl.replace(/\/+$/, '');
  return {
    async resolve(spec, platform, arch): Promise<RegistryArtifact> {
      const url = `${root}/${spec.name}/${spec.version}/${platform}-${arch}.json`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} al resolver ${url}`);
      }
      const data = (await response.json()) as Partial<RegistryArtifact>;
      if (typeof data.url !== 'string' || typeof data.sha256 !== 'string') {
        throw new Error(`Manifest inválido en ${url}: faltan 'url' o 'sha256'`);
      }
      return {
        name: spec.name,
        version: spec.version,
        platform,
        arch,
        url: data.url,
        sha256: data.sha256,
        sizeBytes: typeof data.sizeBytes === 'number' ? data.sizeBytes : undefined,
      };
    },
  };
}

/**
 * Ejecuta `tool install <spec>`. Devuelve el exit code: 0 en éxito, 1 ante
 * cualquier `InstallError` (incluido CHECKSUM_MISMATCH) u error inesperado.
 */
export async function runInstallCommand(
  rawSpec: string,
  deps: RunInstallDeps,
): Promise<number> {
  const out =
    deps.stdout ?? ((line: string): void => { process.stdout.write(`${line}\n`); });
  const err =
    deps.stderr ?? ((line: string): void => { process.stderr.write(`${line}\n`); });

  const service = new InstallService(deps.registry, deps.downloader);
  try {
    const result = await service.install(rawSpec, { installDir: deps.installDir });
    out(`\u2714 Instalado ${result.name}@${result.version}`);
    out(`  path   ${result.installedPath}`);
    out(`  sha256 ${result.sha256}`);
    return 0;
  } catch (error) {
    if (error instanceof InstallError) {
      err(`\u2716 install falló [${error.code}]: ${error.message}`);
    } else {
      err(`\u2716 install falló: ${error instanceof Error ? error.message : String(error)}`);
    }
    return 1;
  }
}

/** Entry point CLI: `tool install foo@1.2.3`. Mapea el exit code al proceso. */
export async function main(argv: readonly string[]): Promise<void> {
  const spec = argv[0];
  if (spec === undefined || spec.length === 0) {
    process.stderr.write('uso: tool install <name@version>\n');
    process.exitCode = 1;
    return;
  }
  const baseUrl = process.env.TOOL_REGISTRY_URL;
  if (baseUrl === undefined || baseUrl.length === 0) {
    process.stderr.write('falta la variable de entorno TOOL_REGISTRY_URL\n');
    process.exitCode = 1;
    return;
  }
  const installDir = process.env.TOOL_INSTALL_DIR ?? join(homedir(), '.tool', 'bin');
  const code = await runInstallCommand(spec, {
    registry: createHttpRegistry(baseUrl),
    downloader: createHttpDownloader(),
    installDir,
  });
  process.exitCode = code;
}
