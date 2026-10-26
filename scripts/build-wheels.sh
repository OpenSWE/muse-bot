#!/bin/sh
# Builds one standalone binary per platform with Bun, then a PyPI wheel around each,
# into pydist/. Run on macOS, so Bun signs the macOS binaries as it builds them.
set -eu
cd "$(dirname "$0")/.."
rm -rf build pydist
for pair in \
  darwin-arm64:macosx_13_0_arm64 \
  darwin-x64-baseline:macosx_13_0_x86_64 \
  linux-x64-baseline:manylinux_2_17_x86_64 \
  linux-arm64:manylinux_2_17_aarch64; do
  target=${pair%%:*}
  tag=${pair#*:}
  # The data files and the Noise wasm land under data/, where the code looks for them.
  bun build --compile --target="bun-$target" src/cli.ts \
    src/data/desc0.bin src/data/desc1.bin node_modules/noise-c.wasm/src/noise-c.wasm \
    --asset-naming="data/[name].[ext]" --outfile build/bin/muse-bot
  uv build --wheel --out-dir build/wheel
  uvx wheel tags --remove --python-tag py3 --abi-tag none --platform-tag "$tag" build/wheel/*.whl
  mkdir -p pydist
  mv build/wheel/*.whl pydist/
  rm -rf build
done
ls -l pydist
