#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import { resolveTool } from './resolver.js';
import { ResolutionError } from './types.js';

/**
 * Codigos de salida del shim (convencion POSIX):
 *  - 127: no hay version pinneada (comando "no encontrado").
 *  - 126: el binario existe pero no pudo ejecutarse.
 *  - 128: el proceso hijo termino por senal.
 */
const EXIT_NOT_FOUND = 127;
const EXIT_CANNOT_EXEC = 126;
const EXIT_SIGNAL = 128;

/**
 * Deriva el nombre de la herramienta a partir de como se invoco el shim.
 * Instalado como symlink en el PATH (p.ej. ~/.cli-manager/shims/node ->
 * shim.js), argv[1] es la ruta del symlink y su basename es el tool name.
 */
function toolNameFrom(argv: readonly string[]): string {
  const invoked = argv[1] ?? argv[0] ?? '';
  return basename(invoked);
}

/**
 * Ejecuta el shim: resuelve la version pinneada y delega la ejecucion al
 * binario real reenviando argumentos, stdio y entorno. Devuelve el codigo
 * de salida a propagar. No lanza para errores de resolucion esperados.
 */
export function runShim(argv: readonly string[] = process.argv): number {
  const tool = toolNameFrom(argv);
  const forwardedArgs = argv.slice(2);

  let binPath: string;
  try {
    binPath = resolveTool(tool).binPath;
  } catch (err) {
    if (err instanceof ResolutionError) {
      process.stderr.write(`cli-manager: ${err.message}\n`);
      return err.kind === 'no-version-file' ? EXIT_NOT_FOUND : EXIT_CANNOT_EXEC;
    }
    throw err;
  }

  const result = spawnSync(binPath, forwardedArgs, {
    stdio: 'inherit',
    env: process.env,
  });

  if (result.error !== undefined) {
    process.stderr.write(
      `cli-manager: fallo al ejecutar ${binPath}: ${result.error.message}\n`,
    );
    return EXIT_CANNOT_EXEC;
  }

  if (typeof result.status === 'number') return result.status;
  return EXIT_SIGNAL; // terminado por senal (result.signal != null).
}

// Auto-ejecucion solo cuando el modulo es el entrypoint del proceso.
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(runShim());
}
