#!/bin/sh
set -eu
cd "$(dirname "$0")"
mkdir -p ../../.local/qa/cloud-sync/ios-protocol
xcrun swiftc AIWatchShared/AttentionState.swift AIWatch/Strings.swift AIWatch/Protocol.swift Tests/main.swift -o ../../.local/qa/cloud-sync/ios-protocol/protocol-tests
../../.local/qa/cloud-sync/ios-protocol/protocol-tests
