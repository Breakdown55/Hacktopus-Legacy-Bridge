import type { TargetLanguage } from '@lb/contracts';

export const NODE_IMAGE = 'node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee';

type Toolchain = {
  image: string;
  command: string[];
  support: Record<string, string>;
  build: string;
};

export const nativeToolchains: Record<Exclude<TargetLanguage, 'typescript'>, Toolchain> = {
  python: {
    image: 'python:3.12-slim-bookworm@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df',
    command: ['python3', '-I', '-B', '{module}/bin/cli.py'],
    support: {
      'bin/cli.py': `import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'dist'))
from replacement import run

try:
    status = run(sys.argv[1:], sys.stdin.buffer, sys.stdout.buffer, sys.stderr.buffer)
except Exception:
    import traceback
    traceback.print_exc()
    status = 70
sys.exit(status)
`,
    },
    build: `python3 -I -c 'from pathlib import Path; [compile(p.read_bytes(), str(p), "exec") for p in Path("src").rglob("*.py")]'
cp -R src/. "$out/dist/"
`,
  },
  go: {
    image: 'golang:1.24-bookworm@sha256:1a6d4452c65dea36aac2e2d606b01b4a029ec90cc1ae53890540ce6173ea77ac',
    command: ['{module}/dist/legacy-cli'],
    support: {
      'go.mod': 'module legacybridge.local/module\n\ngo 1.24\n',
      'cmd/legacy-cli/main.go': `package main

import (
  "os"
  replacement "legacybridge.local/module/src"
)

func main() {
  os.Exit(replacement.Run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}
`,
    },
    build: 'GOMAXPROCS=2 CGO_ENABLED=0 GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off go build -p 2 -trimpath -o "$out/dist/legacy-cli" ./cmd/legacy-cli\n',
  },
  java: {
    image: 'eclipse-temurin:21-jdk-jammy@sha256:432e54724c3e57d1846aeb886f4d339f3b0522931c4e64119c2797013b7cfc3c',
    command: ['java', '-cp', '{module}/dist/replacement.jar', 'legacybridge.Launcher'],
    support: {
      'bin/Launcher.java': `package legacybridge;

public final class Launcher {
    public static void main(String[] args) {
        try {
            System.exit(Replacement.run(args, System.in, System.out, System.err));
        } catch (Exception error) {
            error.printStackTrace(System.err);
            System.exit(70);
        }
    }
}
`,
    },
    build: `mkdir classes
find src -name '*.java' -type f -print | LC_ALL=C sort > sources.txt
printf '%s\\n' bin/Launcher.java >> sources.txt
javac -J-Xmx256m -proc:none -encoding UTF-8 -d classes @sources.txt
jar --create --file "$out/dist/replacement.jar" --date=2000-01-01T00:00:00Z -C classes .
`,
  },
  csharp: {
    image: 'mcr.microsoft.com/dotnet/sdk:8.0-bookworm-slim@sha256:1b955f179b02df4f0eb5fadedaa898cbe44d620a64aab52eec72c8e91d1355b5',
    command: ['dotnet', '{module}/dist/LegacyBridge.dll'],
    support: {
      'LegacyBridge.csproj': `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
    <UseAppHost>false</UseAppHost>
    <NuGetAudit>false</NuGetAudit>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="src/**/*.cs" />
    <Compile Include="bin/Launcher.cs" />
  </ItemGroup>
</Project>
`,
      'NuGet.Config': '<?xml version="1.0" encoding="utf-8"?><configuration><packageSources><clear /></packageSources></configuration>\n',
      'bin/Launcher.cs': `using System;
namespace LegacyBridge;

internal static class Launcher {
    public static int Main(string[] args) {
        try {
            return Replacement.Run(args, Console.OpenStandardInput(), Console.OpenStandardOutput(), Console.OpenStandardError());
        } catch (Exception error) {
            Console.Error.WriteLine(error);
            return 70;
        }
    }
}
`,
    },
    build: `for csc in /usr/share/dotnet/sdk/8.0.*/Roslyn/bincore/csc.dll; do :; done
for reference in /usr/share/dotnet/packs/Microsoft.NETCore.App.Ref/8.0.*/ref/net8.0/*.dll; do
  printf '%s\\n' "-reference:$reference"
done > references.rsp
find src -name '*.cs' -type f -print | LC_ALL=C sort > sources.rsp
printf '%s\\n' bin/Launcher.cs >> sources.rsp
dotnet exec "$csc" -nologo -noconfig -nostdlib+ -target:exe -deterministic+ -optimize+ -langversion:12.0 "-out:$out/dist/LegacyBridge.dll" @references.rsp @sources.rsp
printf '%s\\n' '{"runtimeOptions":{"tfm":"net8.0","framework":{"name":"Microsoft.NETCore.App","version":"8.0.0"}}}' > "$out/dist/LegacyBridge.runtimeconfig.json"
`,
  },
};

export const targetImage = (target: TargetLanguage) => target === 'typescript' ? NODE_IMAGE : nativeToolchains[target].image;
export const targetCommand = (target: TargetLanguage) => target === 'typescript'
  ? ['node', '{module}/bin/cli.mjs'] : nativeToolchains[target].command;

export const toolchainEnv = {
  DOTNET_CLI_HOME: '/tmp', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1',
  DOTNET_NOLOGO: '1',
};

export function buildScript(target: Exclude<TargetLanguage, 'typescript'>) {
  return '#!/bin/sh\nset -eu\nout=${1:-.}\nmkdir -p "$out/dist"\n' + nativeToolchains[target].build;
}
