#!/usr/bin/env bash
#---------------------------------------------------------------------------------------------
#  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
#  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
#---------------------------------------------------------------------------------------------

#
# Two ClickHouse servers in one cluster, with Keeper, on this machine.
#
#   bash deploy/clickhouse-cluster/up.sh          bring it up (idempotent)
#   bash deploy/clickhouse-cluster/up.sh down     remove the containers and the network
#
# This is the fixture the multi-node work needs and a single container cannot give: a real
# coordination layer, so ReplicatedMergeTree has a replication queue, a Distributed table has a
# distribution queue, and `system.zookeeper` has something in it. ClickHouse Cloud cannot stand in
# for it either, because Cloud stores tables as SharedMergeTree and hands out no Keeper.
#
# It leaves the single-node `sd-ch` container alone: different names, different network, ports
# 58124/58125 rather than 58123.
#
#   SNOUTDATA_TEST_CLICKHOUSE_REPLICA_PORTS=58124,58125 SNOUTDATA_TEST_CLICKHOUSE_PASSWORD=pw \
#     npx playwright test clickhouse-replicas-live --project=app
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Docker Desktop on Windows wants a Windows path for a bind mount, and Git Bash rewrites the
# container side of `-v` unless told not to: without both, every config file mounted as an empty
# directory and each server came up as its own one-node `default` cluster.
if command -v cygpath >/dev/null 2>&1; then
	HERE="$(cygpath -m "$HERE")"
	export MSYS_NO_PATHCONV=1
fi
NETWORK=sd-ch-net
IMAGE=clickhouse/clickhouse-server:latest
# A local-lab password only; the ports are published on 127.0.0.1, never to the network.
PASSWORD=pw

if [ "${1:-up}" = "down" ]; then
	docker rm -f ch-a ch-b >/dev/null 2>&1 || true
	docker network rm "$NETWORK" >/dev/null 2>&1 || true
	echo "cluster removed"
	exit 0
fi

docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create "$NETWORK" >/dev/null
docker rm -f ch-a ch-b >/dev/null 2>&1 || true

# ch-a carries Keeper as well as the server, so it is started first and waited for: ch-b cannot
# finish starting a replicated table without a coordination layer to register with.
docker run -d --name ch-a --hostname ch-a --network "$NETWORK" -p 127.0.0.1:58124:8123 \
	-e CLICKHOUSE_USER=default -e CLICKHOUSE_PASSWORD="$PASSWORD" -e CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 \
	--ulimit nofile=262144:262144 \
	-v "$HERE/cluster.xml:/etc/clickhouse-server/config.d/cluster.xml:ro" \
	-v "$HERE/macros-a.xml:/etc/clickhouse-server/config.d/macros.xml:ro" \
	-v "$HERE/logs.xml:/etc/clickhouse-server/config.d/logs.xml:ro" \
	-v "$HERE/keeper.xml:/etc/clickhouse-server/config.d/keeper.xml:ro" \
	"$IMAGE" >/dev/null

docker run -d --name ch-b --hostname ch-b --network "$NETWORK" -p 127.0.0.1:58125:8123 \
	-e CLICKHOUSE_USER=default -e CLICKHOUSE_PASSWORD="$PASSWORD" -e CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 \
	--ulimit nofile=262144:262144 \
	-v "$HERE/cluster.xml:/etc/clickhouse-server/config.d/cluster.xml:ro" \
	-v "$HERE/macros-b.xml:/etc/clickhouse-server/config.d/macros.xml:ro" \
	-v "$HERE/logs.xml:/etc/clickhouse-server/config.d/logs.xml:ro" \
	"$IMAGE" >/dev/null

# "The port answers" is not "the server is ready", so wait on a statement rather than on a socket.
for port in 58124 58125; do
	for _ in $(seq 1 60); do
		if curl -s --max-time 2 "http://127.0.0.1:$port/" \
			-H "X-ClickHouse-User: default" -H "X-ClickHouse-Key: $PASSWORD" \
			--data-binary 'SELECT 1' >/dev/null 2>&1; then
			break
		fi
		sleep 1
	done
done

echo "ch-a http://127.0.0.1:58124   ch-b http://127.0.0.1:58125   user default / $PASSWORD"
curl -s "http://127.0.0.1:58124/" -H "X-ClickHouse-User: default" -H "X-ClickHouse-Key: $PASSWORD" \
	--data-binary "SELECT host_name, port, is_local FROM system.clusters WHERE cluster = 'default' FORMAT TSV"
