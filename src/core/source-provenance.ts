import { execFile } from 'node:child_process';
import { hostname } from 'node:os';
import { promisify } from 'node:util';

import * as z from 'zod/v4';

export const HostSchema = z.strictObject({
  name: z.string().nullable().describe('OS hostname of the machine running the MCP process.'),
  machineId: z.string().nullable().describe('System UUID; null when unavailable.'),
});

export const RootDetailsSchema = z.strictObject({
  path: z.string(),
  volume: z.strictObject({
    label: z.string().nullable(),
    serialNumber: z
      .string()
      .regex(/^[0-9A-F]{4}-[0-9A-F]{4}$/u)
      .nullable()
      .describe('OS volume serial number in XXXX-XXXX hex format; not a device serial.'),
  }),
});

export interface SourceProvenance {
  readonly host: z.infer<typeof HostSchema>;
  readonly root: z.infer<typeof RootDetailsSchema>;
}

type WindowsQuery = (
  kind: 'machine' | 'volume',
  path: string | undefined,
  signal: AbortSignal,
) => Promise<unknown>;

interface ProviderDeps {
  readonly platform?: NodeJS.Platform;
  readonly hostname?: () => string;
  readonly queryWindows?: WindowsQuery;
  readonly timeoutMs?: number;
}

const MACHINE_SCRIPT = `(Get-CimInstance -ClassName Win32_ComputerSystemProduct -ErrorAction Stop).UUID | ConvertTo-Json -Compress`;

// GetVolumePathNameW resolves subdirectories, mounted folders and remote paths.
// Query label/serial independently: a failed field never supplies an output value.
const VOLUME_SCRIPT = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class SourceVolume {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
  public static extern bool GetVolumePathNameW(string path, StringBuilder root, uint size);
  [DllImport("kernel32.dll", EntryPoint = "GetVolumeInformationW", CharSet = CharSet.Unicode, ExactSpelling = true)]
  public static extern bool Label(string root, StringBuilder label, uint size, IntPtr serial, IntPtr max, IntPtr flags, IntPtr fs, uint fsSize);
  [DllImport("kernel32.dll", EntryPoint = "GetVolumeInformationW", CharSet = CharSet.Unicode, ExactSpelling = true)]
  public static extern bool Serial(string root, IntPtr label, uint size, out uint serial, IntPtr max, IntPtr flags, IntPtr fs, uint fsSize);
  [DllImport("kernel32.dll")]
  public static extern uint SetErrorMode(uint mode);
}
'@
[void][SourceVolume]::SetErrorMode(0x8001)
$volumePath = New-Object System.Text.StringBuilder 32768
$result = @{ label = $null; serialNumber = $null }
if ([SourceVolume]::GetVolumePathNameW($env:FSMCP_PROVENANCE_PATH, $volumePath, 32768)) {
  $rootPath = $volumePath.ToString().TrimEnd('\\') + '\\'
  $label = New-Object System.Text.StringBuilder 261
  try {
    if ([SourceVolume]::Label($rootPath, $label, 261, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, 0)) {
      $result.label = $label.ToString()
    }
  } catch {}
  [uint32]$serial = 0
  try {
    if ([SourceVolume]::Serial($rootPath, [IntPtr]::Zero, 0, [ref]$serial, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, 0)) {
      $result.serialNumber = $serial.ToString('X8').Insert(4, '-')
    }
  } catch {}
}
$result | ConvertTo-Json -Compress`;

const execFileAsync = promisify(execFile);

const queryWindows: WindowsQuery = async (kind, path, signal) => {
  const script = `$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);\n${kind === 'machine' ? MACHINE_SCRIPT : VOLUME_SCRIPT}`;
  const { stdout } = await execFileAsync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      signal,
      maxBuffer: 64 * 1024,
      // Paths are data, never interpolated into PowerShell/C# source.
      env: { ...process.env, FSMCP_PROVENANCE_PATH: path ?? '' },
    },
  );
  return JSON.parse(stdout) as unknown;
};

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function uuidOrNull(value: unknown): string | null {
  const uuid = textOrNull(value)?.toUpperCase();
  return uuid &&
    /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/u.test(uuid) &&
    !/^(?:0|-)+$/u.test(uuid) &&
    !/^(?:F|-)+$/u.test(uuid)
    ? uuid
    : null;
}

/** Best-effort metadata only. Callers supply allowed roots or a guarded job source. */
export class SourceProvenanceProvider {
  readonly #platform: NodeJS.Platform;
  readonly #hostname: () => string;
  readonly #queryWindows: WindowsQuery;
  readonly #timeoutMs: number;

  constructor(deps: ProviderDeps = {}) {
    this.#platform = deps.platform ?? process.platform;
    this.#hostname = deps.hostname ?? hostname;
    this.#queryWindows = deps.queryWindows ?? queryWindows;
    this.#timeoutMs = deps.timeoutMs ?? 3_000;
  }

  async #query(kind: 'machine' | 'volume', path?: string): Promise<unknown> {
    if (this.#platform !== 'win32') return null;
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        Promise.resolve()
          .then(() => this.#queryWindows(kind, path, controller.signal))
          .catch(() => null),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => {
            resolve(null);
            controller.abort();
          }, this.#timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async describeRoots(paths: readonly string[]): Promise<{
    host: z.infer<typeof HostSchema>;
    rootDetails: z.infer<typeof RootDetailsSchema>[];
  }> {
    let name: string | null = null;
    try {
      name = textOrNull(this.#hostname());
    } catch {
      /* Hostname failure does not discard the other fields. */
    }
    const [machineId, rootDetails] = await Promise.all([
      this.#query('machine').then(uuidOrNull),
      Promise.all(
        paths.map(async (path) => {
          const result = await this.#query('volume', path);
          const data =
            result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
          const serial = textOrNull(data['serialNumber'])?.toUpperCase();
          const label = data['label'];
          return {
            path,
            volume: {
              label: typeof label === 'string' && label.length > 0 ? label : null,
              serialNumber:
                serial && /^[0-9A-F]{4}-?[0-9A-F]{4}$/u.test(serial)
                  ? `${serial.slice(0, 4)}-${serial.replace('-', '').slice(4)}`
                  : null,
            },
          };
        }),
      ),
    ]);
    return { host: { name, machineId }, rootDetails };
  }

  async capture(path: string): Promise<SourceProvenance> {
    const { host, rootDetails } = await this.describeRoots([path]);
    return { host, root: rootDetails[0] ?? { path, volume: { label: null, serialNumber: null } } };
  }
}

// No metadata cache: an unavailable/changed volume is retried on the next lookup.
export const sourceProvenance = new SourceProvenanceProvider();
