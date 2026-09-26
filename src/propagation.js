'use strict';

const { trace } = require('./trace');

/**
 * 配方源头传播范围查询引擎（纯函数，只读）
 *
 * 选定一个批次及其配方中的一种过敏原，基于一次最新的 trace() 推演结果
 * （trace.nodes 中的 origin / inherit 来源节点）回答：
 *
 *   哪些「其他批次」最终携带该过敏原，且携带来源链可追溯到所选批次的
 *   配方源头？
 *
 * 判定方式：从所选配方源头节点（origin）出发，沿 inherit 节点的 sources
 * 边做正向可达性遍历（源头 → 直接或间接继承它的全部继承节点）；某批次
 * 最终过敏原的来源节点中只要有一个可达，即视为命中。由于继承节点只在
 * 真实发生继承时才会创建，相应过敏原被清洗移除后，下游不会再产生对应
 * 的继承节点，因此已截断的路径天然不会命中。
 *
 * 同一批次无论经过多少台设备、多少条汇合路径被污染，只列出一次：
 * 取其「首次继承」事件（推演规则下同批同种过敏原至多继承一次）展示
 * 设备与时间，并给出一条裁剪后的传播链——只保留能继续回溯到所选源头
 * 的分支，因此沿链逐级展开最终必然到达所选批次的配方源头节点。
 *
 * 本函数不读取也不写入持久化记录：trace() 为不修改入参的纯函数，这里
 * 仅在内存中对当前数据做一次推演并分析其来源节点，不落盘、不产生新 ID。
 *
 * @param {{equipment: Array, batches: Array, cleanings: Array}} data 原始记录
 * @param {{batchId: string, allergen: string}} input 已规范化的入参
 * @returns {object} 传播范围查询结果
 */
function queryPropagation(data, input) {
  const { batchId, allergen } = input;
  const traceResult = trace(data);
  const nodes = traceResult.nodes || {};

  // ---- 定位所选批次的配方源头节点 ----------------------------------------
  // 入参已校验「过敏原属于该批配方」，正常推演下源头节点必然存在；
  // 防御性兜底：缺失时按无传播处理。
  const sourceNode = Object.values(nodes).find(
    (n) => n.kind === 'origin' && n.batchId === batchId && n.allergen === allergen
  );
  const sourceBatch = (traceResult.batches || []).find((b) => b.batchId === batchId);

  // ---- 正向可达性：源头节点 → 所有（直接或间接）继承它的 inherit 节点 -----
  // inherit 节点的 sources 指向上游来源（origin 或更早的 inherit），
  // 这里建立反向索引 sourceId -> [依赖它的节点 id]，从源头做 BFS。
  const dependents = new Map();
  for (const node of Object.values(nodes)) {
    if (node.kind !== 'inherit') continue;
    for (const sid of node.sources || []) {
      let list = dependents.get(sid);
      if (!list) {
        list = [];
        dependents.set(sid, list);
      }
      list.push(node.id);
    }
  }

  const reachable = new Set();
  if (sourceNode) {
    reachable.add(sourceNode.id);
    const queue = [sourceNode.id];
    while (queue.length) {
      const cur = queue.shift();
      for (const next of dependents.get(cur) || []) {
        if (!reachable.has(next)) {
          reachable.add(next);
          queue.push(next);
        }
      }
    }
  }

  // ---- 接触事件时间索引（用于在传播链上标注每次继承发生的时间） -----------
  const contactTime = new Map(); // `${batchId}|${stepIndex}` -> time
  for (const ev of traceResult.timeline || []) {
    if (ev.type === 'contact') {
      contactTime.set(`${ev.batchId}|${ev.stepIndex}`, ev.time);
    }
  }

  // ---- 逐批判定（同一批次只列一次；结果沿用 trace.batches 的时间顺序） ----
  const affected = [];
  for (const br of traceResult.batches || []) {
    if (br.batchId === batchId) continue; // 源头批次本身不属于「其他批次」
    if (!br.finalAllergens.includes(allergen)) continue;
    const hitNodeIds = (br.sources[allergen] || []).filter((id) => reachable.has(id));
    if (!hitNodeIds.length) continue;

    // 首次继承事件：时间线已按时间升序，第一个继承了该过敏原且继承节点
    // 可达的接触事件即首次继承（同批同种过敏原至多继承一次）。
    let first = null;
    for (const ev of traceResult.timeline || []) {
      if (ev.type !== 'contact' || ev.batchId !== br.batchId) continue;
      const inh = (ev.inherited || []).find(
        (x) => x.allergen === allergen && (x.nodeIds || []).some((id) => reachable.has(id))
      );
      if (inh) {
        first = {
          time: ev.time,
          equipmentId: ev.equipmentId,
          equipmentName: ev.equipmentName,
          stepIndex: ev.stepIndex,
          nodeIds: inh.nodeIds.filter((id) => reachable.has(id)),
        };
        break;
      }
    }
    const chainRootIds = first ? first.nodeIds : hitNodeIds;

    affected.push({
      batchId: br.batchId,
      name: br.name,
      time: br.time,
      first: first
        ? {
            time: first.time,
            equipmentId: first.equipmentId,
            equipmentName: first.equipmentName,
            stepIndex: first.stepIndex,
          }
        : null,
      nodeIds: chainRootIds,
      chain: chainRootIds
        .map((id) => buildChain(id, nodes, reachable, contactTime))
        .filter(Boolean),
    });
  }

  return {
    source: {
      batchId,
      name: sourceBatch ? sourceBatch.name : batchId,
      time: sourceBatch ? sourceBatch.time : null,
      allergen,
    },
    affectedCount: affected.length,
    affected,
    message: affected.length
      ? `共有 ${affected.length} 个其他批次最终携带的「${allergen}」可追溯到批次「${sourceBatch ? sourceBatch.name : batchId}」的配方源头。`
      : `没有其他批次通过交叉污染继承批次「${sourceBatch ? sourceBatch.name : batchId}」配方中的「${allergen}」。`,
  };
}

/**
 * 递归裁剪传播链：只保留可回溯到所选源头的分支。
 * 可达集合中的 origin 节点只有所选源头本身，因此每条链的叶子必然
 * 是所选批次的配方源头节点。节点上的 nodeId 对应 trace.nodes 的键，
 * 便于前端与完整来源链对照或做「见上文」去重。
 */
function buildChain(nodeId, nodes, reachable, contactTime) {
  const node = nodes[nodeId];
  if (!node) return null;
  if (node.kind === 'origin') {
    return {
      nodeId: node.id,
      kind: 'origin',
      batchId: node.batchId,
      batchName: node.batchName,
      allergen: node.allergen,
    };
  }
  const children = (node.sources || [])
    .filter((sid) => reachable.has(sid))
    .map((sid) => buildChain(sid, nodes, reachable, contactTime))
    .filter(Boolean);
  return {
    nodeId: node.id,
    kind: 'inherit',
    equipmentId: node.equipmentId,
    equipmentName: node.equipmentName,
    allergen: node.allergen,
    acquiredBy: node.acquiredBy,
    time:
      contactTime.get(`${node.acquiredBy.batchId}|${node.acquiredBy.stepIndex}`) ||
      null,
    sources: children,
  };
}

module.exports = { queryPropagation };
