const RETRIEVED_CODES = ["theme_selected", "target_selected", "log_selected"];

function asList(value) {
  if (value === null || value === undefined || value === "") return [];
  return Array.isArray(value) ? value : [value];
}

function targetGroup(retrievalWorkspace, targetType) {
  if (targetType === "place") return retrievalWorkspace?.places ?? {};
  if (targetType === "city") return retrievalWorkspace?.cities ?? {};
  return {};
}

function targetEntry(retrievalWorkspace, item) {
  return targetGroup(retrievalWorkspace, item.target_type)?.[item.target_name] ?? null;
}

function themeChunkIds(target, theme) {
  return new Set(asList(target?.themes?.[theme]).map((entry) => entry.chunk_id).filter(Boolean));
}

function uniqueChunkIds(target) {
  return new Set(asList(target?.unique_chunk_ids).filter(Boolean));
}

export function findRetrievalRequest(retrievalLog, item) {
  return asList(retrievalLog?.requests).find(
    (request) =>
      request.target_type === item.target_type &&
      request.target_name === item.target_name &&
      request.theme === item.theme,
  );
}

function findLogChunk(request, chunkId) {
  return asList(request?.chunks).find((chunk) => chunk.chunk_id === chunkId) ?? null;
}

function findRerankItem(request, chunkId) {
  return asList(request?.rerank?.items).find((item) => item.chunk_id === chunkId) ?? null;
}

function hasQuotaDrop(target, theme) {
  return Number(target?.retrieval_quota?.dropped_by_theme?.[theme] ?? 0) > 0;
}

function selectedCount(request) {
  return asList(request?.chunks).filter((chunk) => chunk.recall_status === "selected").length;
}

function scoreTotal(logChunk) {
  return Number(logChunk?.score?.total ?? 0);
}

function classifyFromLog({ request, logChunk, rerankItem, target, item }) {
  if (!logChunk && rerankItem && rerankItem.passed_threshold === false) {
    return {
      retrieved: false,
      attribution_code: "rerank_drop",
      stage: "retrieval",
      evidence: { rerank_item: rerankItem },
      suggestion: "降低 rerank 阈值、扩大窗口或调整该 theme 的 rerank query。",
    };
  }
  if (!logChunk) {
    return {
      retrieved: false,
      attribution_code: "unknown",
      stage: "retrieval",
      evidence: { reason: "chunk_not_found_in_retrieval_log" },
      suggestion: "补齐 retrieval-log.json 或检查 baseline source_chunk_ids 是否来自同一索引。",
    };
  }

  if (logChunk.recall_status === "selected") {
    if (hasQuotaDrop(target, item.theme)) {
      return {
        retrieved: false,
        attribution_code: "quota_dropped",
        stage: "retrieval",
        evidence: {
          recall_status: logChunk.recall_status,
          retrieval_quota: target?.retrieval_quota ?? null,
        },
        suggestion: "提高 target 总阅读池配额，或调整 theme 顺序和 top-k。",
      };
    }
    return {
      retrieved: true,
      attribution_code: "log_selected",
      stage: "retrieval",
      evidence: { recall_status: logChunk.recall_status },
      suggestion: "",
    };
  }

  if (logChunk.recall_status === "reranked_filtered" || rerankItem?.passed_threshold === false) {
    return {
      retrieved: false,
      attribution_code: "rerank_drop",
      stage: "retrieval",
      evidence: {
        recall_status: logChunk.recall_status,
        rerank_item: rerankItem,
      },
      suggestion: "降低 rerank 阈值、扩大窗口或调整该 theme 的 rerank query。",
    };
  }

  if (logChunk.recall_status === "zero_score" || logChunk.recall_status === "filtered_by_entity_gate") {
    return {
      retrieved: false,
      attribution_code: "keyword_miss",
      stage: "retrieval",
      evidence: {
        recall_status: logChunk.recall_status,
        gate: logChunk.gate,
        matched_by: logChunk.matched_by,
        score: logChunk.score,
      },
      suggestion: "检查 target 归属、主题词表、别名或 chunk candidate 标注。",
    };
  }

  if (logChunk.recall_status === "scored_not_selected") {
    const rank = Number(logChunk.candidate_rank);
    const topK = Number(request?.top_k);
    const code = Number.isFinite(rank) && Number.isFinite(topK) && rank > topK ? "topk_cut" : "score_low";
    return {
      retrieved: false,
      attribution_code: code,
      stage: "retrieval",
      evidence: {
        recall_status: logChunk.recall_status,
        candidate_rank: logChunk.candidate_rank,
        top_k: request?.top_k,
        selected_count: selectedCount(request),
        score: logChunk.score,
      },
      suggestion: code === "topk_cut" ? "提高该 theme 的 top-k 或扩大 rerank recall window。" : "调整 scoring 权重、主题词或业务降权规则。",
    };
  }

  if (scoreTotal(logChunk) > 0) {
    return {
      retrieved: false,
      attribution_code: "score_low",
      stage: "retrieval",
      evidence: {
        recall_status: logChunk.recall_status,
        score: logChunk.score,
      },
      suggestion: "检查 scoring 权重、排序阈值或业务降权规则。",
    };
  }

  return {
    retrieved: false,
    attribution_code: "unknown",
    stage: "retrieval",
    evidence: {
      recall_status: logChunk.recall_status,
      score: logChunk.score,
    },
    suggestion: "需要人工复查 retrieval-log.json 中该 chunk 的诊断记录。",
  };
}

export function attributeChunkRetrieval({ item, chunkId, retrievalWorkspace, retrievalLog }) {
  const target = targetEntry(retrievalWorkspace, item);
  const themeIds = themeChunkIds(target, item.theme);
  const uniqueIds = uniqueChunkIds(target);

  if (themeIds.has(chunkId)) {
    return {
      item_id: item.id,
      chunk_id: chunkId,
      retrieved: true,
      attribution_code: "theme_selected",
      stage: "retrieval",
      evidence: { target_type: item.target_type, target_name: item.target_name, theme: item.theme },
      suggestion: "",
    };
  }
  if (uniqueIds.has(chunkId)) {
    return {
      item_id: item.id,
      chunk_id: chunkId,
      retrieved: true,
      attribution_code: "target_selected",
      stage: "retrieval",
      evidence: { target_type: item.target_type, target_name: item.target_name },
      suggestion: "",
    };
  }
  if ((item.target_type === "day" || item.target_type === "global") && retrievalWorkspace?.chunks_by_id?.[chunkId]) {
    return {
      item_id: item.id,
      chunk_id: chunkId,
      retrieved: true,
      attribution_code: "target_selected",
      stage: "retrieval",
      evidence: {
        target_type: item.target_type,
        target_name: item.target_name,
        reason: "day_or_global_item_source_chunk_exists_in_reading_pool",
      },
      suggestion: "",
    };
  }

  const request = findRetrievalRequest(retrievalLog, item);
  if (!request) {
    return {
      item_id: item.id,
      chunk_id: chunkId,
      retrieved: false,
      attribution_code: retrievalLog ? "unknown" : "unknown",
      stage: "retrieval",
      evidence: {
        reason: retrievalLog ? "matching_request_not_found" : "retrieval_log_missing",
        target_type: item.target_type,
        target_name: item.target_name,
        theme: item.theme,
      },
      suggestion: retrievalLog ? "检查 target/theme 是否与 retrieval-log.json 一致。" : "补齐 retrieval-log.json 后再输出完整归因。",
    };
  }

  const logChunk = findLogChunk(request, chunkId);
  const rerankItem = findRerankItem(request, chunkId);
  return {
    item_id: item.id,
    chunk_id: chunkId,
    ...classifyFromLog({ request, logChunk, rerankItem, target, item }),
  };
}

export function isRetrievedAttribution(result) {
  return Boolean(result?.retrieved) || RETRIEVED_CODES.includes(result?.attribution_code);
}
