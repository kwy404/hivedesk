// Windows GPU and CPU facts without native dependencies: one long lived, hidden PowerShell process.
//   static: CIM Win32_Processor and Win32_VideoController, the 64 bit VRAM size from the display class
//           registry keys, DXGI adapters (name, vendor, dedicated VRAM, LUID) and AVX2 from
//           IsProcessorFeaturePresent, each in its own try so one failure does not hide the others.
//   sample: the "GPU Engine" and "GPU Adapter Memory" performance counters read with
//           PerformanceCounterCategory.ReadCategory (cheap, no one second Get-Counter wait),
//           utilization computed from two raw samples like Task Manager: per adapter the busiest engine type.
// AMD and Intel GPUs get their live numbers here. NVIDIA is read through nvidia-smi when it exists.
import { spawn } from 'node:child_process';

export const WIN_HELPER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$cpuOk = $false; $dxgiOk = $false; $dxgiError = $null
try {
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class HdCpu {
  [DllImport("kernel32.dll")] public static extern bool IsProcessorFeaturePresent(uint feature);
}
'@
$cpuOk = $true } catch { }
try {
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class HdAdapter { public string Name; public uint VendorId; public uint DeviceId; public ulong Dedicated; public ulong DedicatedSystem; public ulong Shared; public string Luid; public uint Flags; }
public static class HdGpu {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DESC1 {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Description;
    public uint VendorId; public uint DeviceId; public uint SubSysId; public uint Revision;
    public UIntPtr DedicatedVideoMemory; public UIntPtr DedicatedSystemMemory; public UIntPtr SharedSystemMemory;
    public uint LuidLow; public int LuidHigh; public uint Flags;
  }
  [ComImport, Guid("770aae78-f26f-4dba-a829-253c83d1b387"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFactory1 {
    void SetPrivateData(); void SetPrivateDataInterface(); void GetPrivateData(); void GetParent();
    void EnumAdapters(); void MakeWindowAssociation(); void GetWindowAssociation(); void CreateSwapChain(); void CreateSoftwareAdapter();
    [PreserveSig] int EnumAdapters1(uint index, out IAdapter1 adapter);
  }
  [ComImport, Guid("29038f61-3839-4626-91fd-086879011a05"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAdapter1 {
    void SetPrivateData(); void SetPrivateDataInterface(); void GetPrivateData(); void GetParent();
    void EnumOutputs(); void GetDesc(); void CheckInterfaceSupport();
    [PreserveSig] int GetDesc1(out DESC1 desc);
  }
  [DllImport("dxgi.dll")] static extern int CreateDXGIFactory1(ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object factory);
  public static HdAdapter[] List() {
    Guid g = new Guid("770aae78-f26f-4dba-a829-253c83d1b387");
    object o;
    if (CreateDXGIFactory1(ref g, out o) != 0) return new HdAdapter[0];
    IFactory1 f = (IFactory1)o;
    List<HdAdapter> list = new List<HdAdapter>();
    for (uint i = 0; i < 16; i++) {
      IAdapter1 a;
      if (f.EnumAdapters1(i, out a) != 0) break;
      DESC1 d;
      if (a.GetDesc1(out d) == 0) {
        HdAdapter x = new HdAdapter();
        x.Name = d.Description; x.VendorId = d.VendorId; x.DeviceId = d.DeviceId;
        x.Dedicated = (ulong)d.DedicatedVideoMemory; x.DedicatedSystem = (ulong)d.DedicatedSystemMemory; x.Shared = (ulong)d.SharedSystemMemory;
        x.Luid = String.Format("0x{0:x8}_0x{1:x8}", d.LuidHigh, d.LuidLow); x.Flags = d.Flags;
        list.Add(x);
      }
      Marshal.ReleaseComObject(a);
    }
    Marshal.ReleaseComObject(f);
    return list.ToArray();
  }
}
'@
$dxgiOk = $true } catch { $dxgiError = $_.Exception.Message }

function Emit($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 6)); [Console]::Out.Flush() }

function StaticInfo {
  $r = @{ type = 'static'; cpu = $null; controllers = @(); registry = @(); adapters = $null; avx2 = $null; dxgiError = $dxgiError }
  try {
    $p = @(Get-CimInstance Win32_Processor)
    $cores = 0; $threads = 0; foreach ($x in $p) { $cores += [int]$x.NumberOfCores; $threads += [int]$x.NumberOfLogicalProcessors }
    $r.cpu = @{ name = ([string]$p[0].Name).Trim(); cores = $cores; threads = $threads }
  } catch { }
  try {
    $r.controllers = @(Get-CimInstance Win32_VideoController | ForEach-Object { @{ name = [string]$_.Name; adapterRam = [double]$_.AdapterRAM; driver = [string]$_.DriverVersion; pnp = [string]$_.PNPDeviceID } })
  } catch { }
  try {
    $base = 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}'
    $r.registry = @(Get-ChildItem $base -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -match '^\d{4}$' } | ForEach-Object {
      $k = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
      $q = $k.'HardwareInformation.qwMemorySize'
      if ($k.DriverDesc) { @{ name = [string]$k.DriverDesc; qwMemorySize = $(if ($q -ne $null) { [double]$q } else { $null }) } }
    })
  } catch { }
  if ($dxgiOk) {
    try { $r.adapters = @([HdGpu]::List() | ForEach-Object { @{ name = $_.Name; vendorId = $_.VendorId; deviceId = $_.DeviceId; dedicated = [double]$_.Dedicated; dedicatedSystem = [double]$_.DedicatedSystem; shared = [double]$_.Shared; luid = $_.Luid; flags = $_.Flags } }) } catch { $r.dxgiError = $_.Exception.Message }
  }
  if ($cpuOk) { try { $r.avx2 = [HdCpu]::IsProcessorFeaturePresent(40) } catch { } }
  Emit $r
}

$prev = @{}
function Sample {
  $r = @{ type = 'sample'; util = $null; dedicated = $null; shared = $null }
  try {
    $data = (New-Object System.Diagnostics.PerformanceCounterCategory('GPU Engine')).ReadCategory()
    $col = $data['utilization percentage']
    $next = @{}; $sum = @{}
    if ($col) {
      foreach ($inst in $col.Values) {
        $m = [regex]::Match($inst.InstanceName, 'luid_(0x[0-9a-fA-F]+_0x[0-9a-fA-F]+)_phys_\d+_eng_\d+_engtype_(.*)$')
        if (-not $m.Success) { continue }
        $s = $inst.Sample; $next[$inst.InstanceName] = $s
        $p = $prev[$inst.InstanceName]
        if ($p -eq $null) { continue }
        $v = [System.Diagnostics.CounterSampleCalculator]::ComputeCounterValue($p, $s)
        $key = $m.Groups[1].Value.ToLower() + '|' + $m.Groups[2].Value
        if ($sum.ContainsKey($key)) { $sum[$key] += $v } else { $sum[$key] = $v }
      }
      $hadPrev = $prev.Count -gt 0
      $script:prev = $next
      if ($hadPrev) {
        $util = @{}
        foreach ($k in $sum.Keys) { $l = $k.Split('|')[0]; if (-not $util.ContainsKey($l) -or $sum[$k] -gt $util[$l]) { $util[$l] = $sum[$k] } }
        $r.util = $util
      }
    }
  } catch { }
  try {
    $data = (New-Object System.Diagnostics.PerformanceCounterCategory('GPU Adapter Memory')).ReadCategory()
    $ded = @{}; $sh = @{}
    foreach ($pair in @(@('dedicated usage', $ded), @('shared usage', $sh))) {
      $col = $data[$pair[0]]
      if (-not $col) { continue }
      foreach ($inst in $col.Values) {
        $m = [regex]::Match($inst.InstanceName, 'luid_(0x[0-9a-fA-F]+_0x[0-9a-fA-F]+)_phys_\d+')
        if ($m.Success) { $l = $m.Groups[1].Value.ToLower(); $pair[1][$l] = [double]$inst.RawValue + $(if ($pair[1].ContainsKey($l)) { $pair[1][$l] } else { 0 }) }
      }
    }
    $r.dedicated = $ded; $r.shared = $sh
  } catch { }
  Emit $r
}

while (($line = [Console]::In.ReadLine()) -ne $null) {
  $cmd = $line.Trim()
  if ($cmd -eq 'static') { StaticInfo }
  elseif ($cmd -eq 'sample') { Sample }
  elseif ($cmd -eq 'quit') { break }
}
`;

/** UTF-16LE base64, the form powershell.exe -EncodedCommand reads. */
export function encodeCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * The helper process. Requests are serialized; each answer is one JSON line.
 * Any failure (no PowerShell, a crash, a timeout) makes the helper unavailable and every value unknown.
 */
export class WinGpuHelper {
  /** @param {{ spawnImpl?: typeof spawn, exe?: string }} [opts] */
  constructor(opts = {}) {
    this.spawnImpl = opts.spawnImpl || spawn;
    this.exe = opts.exe || 'powershell.exe';
    this.proc = null;
    this.failed = null;
    this.waiters = [];
    this.chain = Promise.resolve();
  }

  _start() {
    if (this.proc || this.failed) return;
    let proc;
    try {
      proc = this.spawnImpl(this.exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodeCommand(WIN_HELPER_SCRIPT)], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'ignore']
      });
    } catch (err) {
      this.failed = String(err?.message || err);
      return;
    }
    this.proc = proc;
    let buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      if (this.proc !== proc) return;   // a process that was replaced: its late lines are dropped
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('{')) continue;
        const w = this.waiters.shift();
        if (!w) continue;
        try { w.resolve(JSON.parse(line)); } catch { w.resolve(null); }
      }
    });
    const dead = (why) => {
      if (this.proc !== proc) return;
      this.failed = this.failed || why;
      this.proc = null;
      for (const w of this.waiters.splice(0)) w.resolve(null);
    };
    proc.on('error', (err) => dead(String(err?.message || err)));
    proc.on('exit', (code) => dead(`exited with ${code}`));
    proc.stdin.on('error', () => { /* the process is gone; exit handles it */ });
    proc.unref?.();
    proc.stdout.unref?.();
    proc.stdin.unref?.();
  }

  /** @param {'static'|'sample'} cmd @param {number} ms */
  request(cmd, ms) {
    const run = () => new Promise((resolve) => {
      this._start();
      if (!this.proc) return resolve(null);
      const w = { resolve: (v) => { clearTimeout(timer); resolve(v); } };
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i !== -1) this.waiters.splice(i, 1);
        // A late answer would be read as the next request's answer: start a fresh process instead,
        // and give up after three timeouts (a machine that busy gets "unknown", not stale numbers).
        this.timeouts = (this.timeouts || 0) + 1;
        this.close(this.timeouts >= 3 ? 'timed out three times' : 'restart');
        resolve(null);
      }, ms);
      timer.unref?.();
      this.waiters.push(w);
      try { this.proc.stdin.write(cmd + '\n'); } catch { w.resolve(null); }
    });
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  close(why = 'closed') {
    const p = this.proc;
    this.proc = null;
    if (why !== 'closed' && why !== 'restart') this.failed = why;
    if (why === 'closed') this.failed = this.failed || 'closed';
    if (p) {
      try { p.stdin.write('quit\n'); p.stdin.end(); } catch { /* gone */ }
      setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, 1000).unref?.();
    }
  }
}
