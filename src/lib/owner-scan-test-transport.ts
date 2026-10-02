type StoredRow = { user_id: string; data: Record<string, unknown>; revision: number };

export function createOwnerScanTransport() {
  const rows = new Map<string, StoredRow>();
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let pageFailure: Error | undefined;
  const queryRows = (table: string, selection: string, cursor?: string, userId?: string) => {
    if (table === "jobs") return [];
    if (userId) {
      const row = rows.get(userId);
      return row ? [{ data: row.data, revision: row.revision }] : [];
    }
    const owners = [...rows.values()].sort((a, b) => a.user_id.localeCompare(b.user_id));
    return owners.filter((row) => !cursor || row.user_id > cursor).map((row) => selection.includes("data") ? row : { user_id: row.user_id });
  };
  const read = (table: string, selection: string, cursor?: string, userId?: string) => pageFailure && cursor ? { data: [], error: pageFailure } : { data: queryRows(table, selection, cursor, userId), error: null };
  const client = {
    from(table: string) {
      return {
        select(selection: string) {
          let cursor: string | undefined;
          let userId: string | undefined;
          const query = {
            eq(field: string, value: string) { if (field === "user_id") userId = value; return query; },
            gt(_field: string, value: string) { cursor = value; return query; },
            order() { return query; },
            limit(limit: number) { void limit; return query; },
            range(from: number, to: number) {
              const response = read(table, selection, cursor, userId);
              return Promise.resolve({ data: response.data.slice(from, to + 1), error: response.error });
            },
            maybeSingle() {
              const response = read(table, selection, cursor, userId);
              return Promise.resolve({ data: response.data[0] ?? null, error: response.error });
            },
            then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
              return Promise.resolve(read(table, selection, cursor, userId)).then(resolve, reject);
            },
          };
          return query;
        },
        update(payload: { data: Record<string, unknown>; revision: number }) {
          let userId: string | undefined;
          let revision: number | undefined;
          const mutation = {
            eq(field: string, value: string | number) { if (field === "user_id") userId = String(value); if (field === "revision") revision = Number(value); return mutation; },
            select() {
              const row = userId ? rows.get(userId) : undefined;
              if (!row || row.revision !== revision) return Promise.resolve({ data: [], error: null });
              row.data = payload.data;
              row.revision = payload.revision;
              return Promise.resolve({ data: [{ revision: row.revision }], error: null });
            },
          };
          return mutation;
        },
        insert(payload: StoredRow) {
          rows.set(payload.user_id, structuredClone(payload));
          return Promise.resolve({ error: null });
        },
        upsert(payload: StoredRow[]) {
          payload.forEach((row) => rows.set(row.user_id, structuredClone(row)));
          return Promise.resolve({ error: null });
        },
      };
    },
    async rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      if (name === "reserve_queued_service_budget") return { data: { queuedId: args.p_queued_id, reservationId: `queued:${args.p_queued_id}`, month: args.p_month, ownerId: args.p_owner_id, applicationId: args.p_application_id, projectedUsd: args.p_amount }, error: null };
      return { data: true, error: null };
    },
  };
  return { client, rows, rpcCalls, setPageFailure: (error: Error | undefined) => { pageFailure = error; } };
}
