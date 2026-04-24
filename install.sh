#!/usr/bin/env bash
set -euo pipefail

REPO="lucianfialho/paper7"
INSTALL_DIR="${HOME}/.local/bin"
BIN_NAME="paper7"
PAPER7_HOME="${HOME}/.paper7"
SQLITE_VEC_REPO="asg017/sqlite-vec"

echo "Installing paper7..."

mkdir -p "$INSTALL_DIR" "$PAPER7_HOME"

curl -sL "https://raw.githubusercontent.com/${REPO}/main/paper7.sh" -o "${INSTALL_DIR}/${BIN_NAME}"
chmod +x "${INSTALL_DIR}/${BIN_NAME}"

# --- sqlite-vec ---
echo "Installing sqlite-vec extension..."

VEC_VERSION=$(curl -sL "https://api.github.com/repos/${SQLITE_VEC_REPO}/releases/latest" \
  | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": "\(.*\)".*/\1/')

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "${OS}-${ARCH}" in
  darwin-arm64|darwin-aarch64)  PLATFORM="macos-aarch64" ; EXT="dylib" ;;
  darwin-x86_64)                PLATFORM="macos-x86_64"  ; EXT="dylib" ;;
  linux-aarch64|linux-arm64)    PLATFORM="linux-aarch64"  ; EXT="so"    ;;
  linux-x86_64)                 PLATFORM="linux-x86_64"   ; EXT="so"    ;;
  *)
    echo "Warning: sqlite-vec has no prebuilt binary for ${OS}-${ARCH}."
    echo "  paper7 kb will use BM25-only mode (no semantic search)."
    PLATFORM=""
    ;;
esac

if [ -n "$PLATFORM" ]; then
  VEC_TARBALL="sqlite-vec-${VEC_VERSION#v}-loadable-${PLATFORM}.tar.gz"
  VEC_URL="https://github.com/${SQLITE_VEC_REPO}/releases/download/${VEC_VERSION}/${VEC_TARBALL}"
  TMP=$(mktemp -d)
  curl -sL "$VEC_URL" -o "${TMP}/sqlite-vec.tar.gz"
  tar -xzf "${TMP}/sqlite-vec.tar.gz" -C "$TMP"
  cp "${TMP}/vec0.${EXT}" "${PAPER7_HOME}/sqlite-vec.${EXT}"
  rm -rf "$TMP"
  echo "sqlite-vec ${VEC_VERSION} installed to ${PAPER7_HOME}/sqlite-vec.${EXT}"
fi

# Check if ~/.local/bin is in PATH
if ! echo "$PATH" | grep -q "${INSTALL_DIR}"; then
  echo ""
  echo "Add ~/.local/bin to your PATH:"
  echo "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc"
  echo ""
fi

echo "paper7 installed to ${INSTALL_DIR}/${BIN_NAME}"
echo "Run: paper7 search \"attention mechanism\""
