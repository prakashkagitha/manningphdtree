const d3 = window.d3;
if (!d3) {
  throw new Error("D3 failed to load. Please ensure the D3 script tag is available.");
}
console.info("D3 version:", d3.version);

const state = {
  data: null,
  nodes: [],
  edges: [],
  filteredNodes: [],
  selectedNodeId: null,
};

const graphState = {
  svg: null,
  zoomLayer: null,
  nodeSelection: null,
  linkSelection: null,
  simulation: null,
  zoom: null,
  currentTransform: d3.zoomIdentity,
  container: null,
  nodesById: new Map(),
  clusterCenters: new Map(),
  directAdvisees: [],
  size: { width: 0, height: 0 },
  maxDepth: 0,
  resizeObserver: null,
  initialFocusDone: false,
  initialFocusScheduled: false,
  parentByChild: new Map(),
  childrenByParent: new Map(),
  depthById: new Map(),
  lineageNodes: new Set(),
  lineageEdges: new Set(),
  hoveredId: null,
  maxDescendants: 0,
};

let previewLoadTimeout = null;

const formatNumber = (value) => new Intl.NumberFormat().format(value ?? 0);

const elements = {
  summaryTotalNodes: document.getElementById("summary-total-nodes"),
  summaryDirectAdvisees: document.getElementById("summary-direct-advisees"),
  summaryDepth: document.getElementById("summary-depth"),
  summaryInstitutions: document.getElementById("summary-institutions"),
  summaryGenerated: document.getElementById("summary-generated"),
  searchInput: document.getElementById("search-input"),
  depthFilter: document.getElementById("depth-filter"),
  rosterList: document.getElementById("roster-list"),
  profileCard: document.getElementById("profile-card"),
  profileName: document.getElementById("profile-name"),
  profileGeneration: document.getElementById("profile-generation"),
  profileAffiliation: document.getElementById("profile-affiliation"),
  profileDescendants: document.getElementById("profile-descendants"),
  profileAdvisees: document.getElementById("profile-advisees"),
  profileResearch: document.getElementById("profile-research"),
  profileLinks: document.getElementById("profile-links"),
  previewCard: document.getElementById("preview-card"),
  previewFrame: document.getElementById("profile-preview-frame"),
  previewStatus: document.getElementById("profile-preview-status"),
  previewRefresh: document.getElementById("preview-refresh"),
};

elements.previewRefresh.disabled = true;

const depthColors = ["#345CFF", "#1CB5E0", "#00B894", "#FDC830", "#F76B1C", "#d853a6"];

const computeInfluenceScore = (node) => {
  if (!node) return 0;
  const totalDesc = Number(node.total_descendants ?? 0);
  const directAdv = Number(node.direct_advisee_count ?? 0);
  return totalDesc + directAdv * 0.5;
};

const normalizeValue = (value, maxValue) => {
  if (!maxValue) return 0;
  return value <= 0 ? 0 : Math.min(1, value / maxValue);
};

const normalizeInfluence = (node, maxInfluence) => {
  if (!node || !maxInfluence) return 0;
  const score = computeInfluenceScore(node);
  return normalizeValue(score, maxInfluence);
};

const computeClusterCenters = (width, height, directAdvisees, rootId) => {
  const centers = new Map();
  const center = { x: width / 2, y: height / 2 };
  centers.set(rootId, center);
  if (!directAdvisees.length) {
    return centers;
  }

  const baseRadius = Math.min(width, height) * 0.32;
  const maxInfluence =
    directAdvisees.reduce((max, node) => Math.max(max, computeInfluenceScore(node)), 0) || 1;
  directAdvisees.forEach((node, index) => {
    const angle = (index / directAdvisees.length) * Math.PI * 2 - Math.PI / 2;
    const influenceBoost = normalizeInfluence(node, maxInfluence);
    const radius = baseRadius * (1 + influenceBoost * 0.6);
    centers.set(node.id, {
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
    });
  });
  return centers;
};

const radialRadius = (depth) => {
  const { width, height } = graphState.size;
  if (!width || !height) return 0;
  const minDim = Math.min(width, height);
  const spacing = Math.max(130, minDim / Math.max(2, graphState.maxDepth + 1.5));
  return depth === 0 ? 0 : spacing * depth;
};

const getClusterTarget = (node) => {
  const target = graphState.clusterCenters.get(node.clusterId);
  if (target) return target;
  const { width, height } = graphState.size;
  return { x: width / 2, y: height / 2 };
};

const edgeKey = (sourceId, targetId) => `${sourceId}|${targetId}`;

const getPreferredParent = (nodeId) => {
  const parents = graphState.parentByChild.get(nodeId);
  if (!parents || !parents.length) return null;
  const depthMap = graphState.depthById;
  const best = parents.reduce((currentBest, candidate) => {
    if (!candidate) return currentBest;
    if (!currentBest) return candidate;
    const candidateDepth = depthMap.get(candidate) ?? Number.POSITIVE_INFINITY;
    const bestDepth = depthMap.get(currentBest) ?? Number.POSITIVE_INFINITY;
    if (candidateDepth < bestDepth) return candidate;
    if (candidateDepth === bestDepth) {
      return candidate < currentBest ? candidate : currentBest;
    }
    return currentBest;
  }, null);
  return best ?? parents[0];
};

const applyLineageClasses = () => {
  const hasLineage = graphState.lineageNodes && graphState.lineageNodes.size > 0;
  const shouldDim = graphState.lineageNodes && graphState.lineageNodes.size > 1;
  if (graphState.nodeSelection) {
    graphState.nodeSelection
      .classed("lineage-active", (node) => hasLineage && graphState.lineageNodes.has(node.id))
      .classed("lineage-muted", (node) => shouldDim && !graphState.lineageNodes.has(node.id));
  }
  if (graphState.linkSelection) {
    graphState.linkSelection
      .classed("lineage-active", (link) => {
        const sourceId = typeof link.source === "object" ? link.source.id : link.source;
        const targetId = typeof link.target === "object" ? link.target.id : link.target;
        return hasLineage && graphState.lineageEdges.has(edgeKey(sourceId, targetId));
      })
      .classed("lineage-muted", (link) => {
        if (!shouldDim) return false;
        const sourceId = typeof link.source === "object" ? link.source.id : link.source;
        const targetId = typeof link.target === "object" ? link.target.id : link.target;
        return !graphState.lineageEdges.has(edgeKey(sourceId, targetId));
      });
  }
};

const updateLineageHighlight = (nodeId) => {
  const lineageNodes = new Set();
  const lineageEdges = new Set();
  if (nodeId) {
    const seen = new Set();
    let current = nodeId;
    while (current && !seen.has(current)) {
      seen.add(current);
      lineageNodes.add(current);
      if (current === state.data.root) break;
      const parent = getPreferredParent(current);
      if (!parent) break;
      lineageEdges.add(edgeKey(parent, current));
      current = parent;
    }
    lineageNodes.add(state.data.root);
  }
  graphState.lineageNodes = lineageNodes;
  graphState.lineageEdges = lineageEdges;
  applyLineageClasses();
};

const clearLineageHighlight = () => {
  graphState.lineageNodes = new Set();
  graphState.lineageEdges = new Set();
  applyLineageClasses();
};

const applyHoverHighlight = (nodeId = null) => {
  const relatedNodes = new Set();
  const relatedEdges = new Set();
  if (nodeId) {
    relatedNodes.add(nodeId);
    const parent = getPreferredParent(nodeId);
    if (parent) {
      relatedNodes.add(parent);
      relatedEdges.add(edgeKey(parent, nodeId));
    }
    const children = graphState.childrenByParent.get(nodeId) || [];
    children.forEach((child) => {
      relatedNodes.add(child);
      relatedEdges.add(edgeKey(nodeId, child));
    });
  }
  const hasHover = !!nodeId;
  if (graphState.nodeSelection) {
    graphState.nodeSelection
      .classed("hovered", (node) => hasHover && relatedNodes.has(node.id))
      .classed("hover-muted", (node) => hasHover && !relatedNodes.has(node.id));
  }
  if (graphState.linkSelection) {
    graphState.linkSelection
      .classed("hovered", (link) => {
        if (!hasHover) return false;
        const sourceId = typeof link.source === "object" ? link.source.id : link.source;
        const targetId = typeof link.target === "object" ? link.target.id : link.target;
        return relatedEdges.has(edgeKey(sourceId, targetId));
      })
      .classed("hover-muted", (link) => {
        if (!hasHover) return false;
        const sourceId = typeof link.source === "object" ? link.source.id : link.source;
        const targetId = typeof link.target === "object" ? link.target.id : link.target;
        return !relatedEdges.has(edgeKey(sourceId, targetId));
      });
  }
  graphState.hoveredId = nodeId;
};
const highlightGraphSelection = (nodeId) => {
  if (graphState.nodeSelection) {
    graphState.nodeSelection.classed("selected", (node) => node.id === nodeId);
    const activeNode = graphState.nodeSelection.filter((node) => node.id === nodeId);
    if (!activeNode.empty()) {
      activeNode.raise();
    }
  }
  if (graphState.linkSelection) {
    graphState.linkSelection.classed("selected", (link) => {
      const sourceId = typeof link.source === "object" ? link.source.id : link.source;
      const targetId = typeof link.target === "object" ? link.target.id : link.target;
      return sourceId === nodeId || targetId === nodeId;
    });
  }
};

const focusGraphNode = (nodeId, { scale = 1.2 } = {}) => {
  if (!graphState.svg || !graphState.zoom) return;
  const node = graphState.nodesById.get(nodeId);
  if (!node) return;
  if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) {
    window.requestAnimationFrame(() => focusGraphNode(nodeId, { scale }));
    return;
  }
  const { width, height } = graphState.size;
  const clampedScale = Math.min(3, Math.max(0.5, scale));
  const transform = d3.zoomIdentity
    .translate(width / 2 - node.x * clampedScale, height / 2 - node.y * clampedScale)
    .scale(clampedScale);
  graphState.currentTransform = transform;
  graphState.svg.transition().duration(600).call(graphState.zoom.transform, transform);
};

const getGraphBounds = () => {
  if (!graphState.nodesById || !graphState.nodesById.size) return null;
  const nodes = Array.from(graphState.nodesById.values()).filter(
    (node) => Number.isFinite(node.x) && Number.isFinite(node.y)
  );
  if (!nodes.length) return null;
  const minX = d3.min(nodes, (node) => node.x);
  const maxX = d3.max(nodes, (node) => node.x);
  const minY = d3.min(nodes, (node) => node.y);
  const maxY = d3.max(nodes, (node) => node.y);
  if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minY) || !Number.isFinite(maxY)) {
    return null;
  }
  return { minX, maxX, minY, maxY };
};

const focusGraphBounds = ({ padding = 200, maxScale = 1.05 } = {}) => {
  if (!graphState.svg || !graphState.zoom) return false;
  const bounds = getGraphBounds();
  if (!bounds) return false;
  const { width, height } = graphState.size;
  if (!width || !height) return false;
  const boundsWidth = Math.max(1, bounds.maxX - bounds.minX);
  const boundsHeight = Math.max(1, bounds.maxY - bounds.minY);
  const scaleX = width / (boundsWidth + padding);
  const scaleY = height / (boundsHeight + padding);
  const targetScale = Math.min(maxScale, Math.min(scaleX, scaleY));
  const clampedScale = Math.min(2, Math.max(0.35, targetScale));
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  const transform = d3.zoomIdentity
    .translate(width / 2 - centerX * clampedScale, height / 2 - centerY * clampedScale)
    .scale(clampedScale);
  graphState.currentTransform = transform;
  graphState.svg.transition().duration(600).call(graphState.zoom.transform, transform);
  return true;
};

const attemptInitialFocus = () => {
  if (graphState.initialFocusDone) return;
  const { width, height } = graphState.size;
  if (!width || !height || width < 240 || height < 240) {
    window.requestAnimationFrame(attemptInitialFocus);
    return;
  }
  const root = graphState.nodesById.get(state.data.root);
  if (!root || !Number.isFinite(root.x) || !Number.isFinite(root.y)) {
    window.requestAnimationFrame(attemptInitialFocus);
    return;
  }
  graphState.initialFocusDone = true;
  graphState.initialFocusScheduled = false;
  const didFitView = focusGraphBounds({ padding: 260, maxScale: 0.95 });
  if (!didFitView) {
    focusGraphNode(state.data.root, { scale: 0.85 });
  }
};

const scheduleInitialFocus = () => {
  if (graphState.initialFocusDone || graphState.initialFocusScheduled) return;
  graphState.initialFocusScheduled = true;
  window.requestAnimationFrame(attemptInitialFocus);
};

const init = async () => {
  try {
    const response = await fetch("manning_tree_latest.json");
    state.data = await response.json();
  } catch (error) {
    console.error("Failed to load data", error);
    elements.summaryTotalNodes.textContent = "Error";
    return;
  }

  enrichState();
  populateSummary();
  populateFilters();
  renderRoster();
  try {
    initGraph();
  } catch (error) {
    console.error("Graph initialization failed:", error);
    showGraphError(error);
  }
  wireEvents();
};

const enrichState = () => {
  state.nodes = state.data.nodes.map((node) => ({
    ...node,
    searchHaystack: buildSearchHaystack(node),
    affiliationDisplay: node.affiliation_name || node.affiliation_domain || "—",
    depthLabel: depthLabel(node.depth),
  }));
  state.edges = state.data.edges;
  state.filteredNodes = [...state.nodes];
};

const buildSearchHaystack = (node) => {
  const parts = [
    node.name,
    node.affiliation_name,
    node.affiliation_domain,
    node.research_area_summary,
    ...(node.expertise_keywords || []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return parts;
};

const depthLabel = (depth) => {
  if (depth === 0) return "Generation 0 (Chris Manning)";
  if (depth === 1) return "Generation 1 (Direct PhD student)";
  return `Generation ${depth}`;
};

const populateSummary = () => {
  const {
    summary: { total_nodes, direct_advisees, max_depth, depth_counts, generated_from },
    nodes,
  } = state.data;

  elements.summaryTotalNodes.textContent = formatNumber(total_nodes);
  elements.summaryDirectAdvisees.textContent = formatNumber(direct_advisees);
  elements.summaryDepth.textContent = formatNumber(max_depth + 1);

  const uniqueInstitutions = new Set(
    nodes
      .map((n) => n.affiliation_name || n.affiliation_domain)
      .filter(Boolean)
  );
  elements.summaryInstitutions.textContent = uniqueInstitutions.size
    ? formatNumber(uniqueInstitutions.size)
    : "–";

  const generatedStamp =
    state.data.generated_at ||
    new Date().toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  elements.summaryGenerated.textContent = `${generated_from ?? "OpenReview"}, ${generatedStamp}`;

  // optional: show tooltip with depth counts
  elements.summaryDepth.title = Object.entries(depth_counts)
    .map(([depth, count]) => `Generation ${depth}: ${formatNumber(count)} people`)
    .join("\n");
};

const populateFilters = () => {
  const depths = Array.from(new Set(state.nodes.map((node) => node.depth))).sort((a, b) => a - b);
  depths.forEach((depth) => {
    const option = document.createElement("option");
    option.value = String(depth);
    option.textContent = depthLabel(depth);
    elements.depthFilter.appendChild(option);
  });
};

const wireEvents = () => {
  elements.searchInput.addEventListener("input", handleFiltersChanged);
  elements.depthFilter.addEventListener("change", handleFiltersChanged);
  elements.previewRefresh.addEventListener("click", handlePreviewRefresh);
  elements.previewFrame.addEventListener("load", handlePreviewLoad);
  elements.previewFrame.addEventListener("error", handlePreviewError);
};

const handleFiltersChanged = () => {
  const searchTerm = elements.searchInput.value.trim().toLowerCase();
  const depthValue = elements.depthFilter.value;

  state.filteredNodes = state.nodes.filter((node) => {
    const matchesSearch = searchTerm
      ? node.searchHaystack.includes(searchTerm)
      : true;
    const matchesDepth = depthValue === "all" ? true : String(node.depth) === depthValue;
    return matchesSearch && matchesDepth;
  });

  renderRoster();
};

const renderRoster = () => {
  elements.rosterList.innerHTML = "";
  if (!state.filteredNodes.length) {
    const empty = document.createElement("li");
    empty.textContent = "No people match your filters yet.";
    empty.classList.add("empty");
    elements.rosterList.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  state.filteredNodes.forEach((node) => {
    const li = document.createElement("li");
    li.dataset.id = node.id;
    li.innerHTML = `
      <div class="name">${node.name}</div>
      <div class="meta">
        ${node.affiliationDisplay} • Direct PhD students: ${formatNumber(
          node.direct_advisee_count
        )} • Gen ${node.depth}
      </div>
    `;
    li.addEventListener("click", () => selectNode(node.id, { focus: true }));
    li.addEventListener("dblclick", () => openProfileLink(node));
    fragment.appendChild(li);
  });

  elements.rosterList.appendChild(fragment);
  highlightRosterSelection();
};

const initGraph = () => {
  console.time("initGraph");
  const container = document.getElementById("network");
  if (!container) return;

  const svg = d3.select(container).select("svg.graph-canvas");
  if (!svg.node()) return;

  svg.selectAll("*").remove();
  if (graphState.resizeObserver) {
    graphState.resizeObserver.disconnect();
    graphState.resizeObserver = null;
  }

  graphState.container = container;
  graphState.svg = svg;
  graphState.initialFocusDone = false;
  graphState.initialFocusScheduled = false;
  graphState.lineageNodes = new Set();
  graphState.lineageEdges = new Set();
  graphState.hoveredId = null;

  const zoomLayer = svg.append("g").attr("class", "graph-viewport");
  const linkGroup = zoomLayer.append("g").attr("class", "graph-links");
  const nodeGroup = zoomLayer.append("g").attr("class", "graph-nodes");
  graphState.zoomLayer = zoomLayer;

  const rect = container.getBoundingClientRect();
  const width = rect.width || container.clientWidth || 960;
  const height = rect.height || container.clientHeight || 720;
  graphState.size = { width, height };

  svg.attr("viewBox", `0 0 ${width} ${height}`).attr("preserveAspectRatio", "xMidYMid meet");

  const rootId = state.data.root;
  const depthById = new Map(state.nodes.map((node) => [node.id, node.depth ?? 0]));

  const parentByChild = new Map();
  const childrenByParent = new Map();
  state.edges.forEach((edge) => {
    if (!parentByChild.has(edge.to)) {
      parentByChild.set(edge.to, []);
    }
    parentByChild.get(edge.to).push(edge.from);
    if (!childrenByParent.has(edge.from)) {
      childrenByParent.set(edge.from, []);
    }
    childrenByParent.get(edge.from).push(edge.to);
  });

  const clusterCache = new Map([[rootId, rootId]]);
  const getClusterId = (nodeId) => {
    if (clusterCache.has(nodeId)) {
      return clusterCache.get(nodeId);
    }
    if (nodeId === rootId) {
      clusterCache.set(nodeId, rootId);
      return rootId;
    }

    const visited = new Set([nodeId]);
    let current = nodeId;
    let clusterCandidate = rootId;

    while (true) {
      const parents = parentByChild.get(current);
      if (!parents || !parents.length) {
        clusterCandidate = rootId;
        break;
      }

      const currentDepth = depthById.get(current) ?? Number.POSITIVE_INFINITY;
      let nextParent =
        parents.find((parent) => (depthById.get(parent) ?? Number.POSITIVE_INFINITY) < currentDepth) ??
        parents[0];

      if (!nextParent || visited.has(nextParent)) {
        clusterCandidate = rootId;
        break;
      }

      if (nextParent === rootId) {
        clusterCandidate = current;
        break;
      }

      visited.add(nextParent);
      current = nextParent;
    }

    const resolved = clusterCandidate === nodeId ? nodeId : clusterCandidate;
    visited.forEach((visitedId) => {
      if (!clusterCache.has(visitedId)) {
        clusterCache.set(visitedId, visitedId === rootId ? rootId : resolved);
      }
    });
    clusterCache.set(nodeId, resolved);
    return resolved;
  };

  const nodes = state.nodes.map((node) => ({
    ...node,
    clusterId: getClusterId(node.id),
  }));

  const links = state.edges.map((edge) => ({
    source: edge.from,
    target: edge.to,
  }));
  console.info("Graph data ready", { nodeCount: nodes.length, linkCount: links.length });

  graphState.maxDepth = d3.max(nodes, (node) => node.depth ?? 0) ?? 0;
  graphState.directAdvisees = nodes.filter((node) => node.id !== rootId && node.clusterId === node.id);
  graphState.parentByChild = parentByChild;
  graphState.childrenByParent = childrenByParent;
  graphState.depthById = depthById;
  graphState.maxInfluence = d3.max(nodes, (node) => computeInfluenceScore(node)) ?? 0;
  graphState.maxDescendants = d3.max(nodes, (node) => node.total_descendants ?? 0) ?? 0;
  graphState.clusterCenters = computeClusterCenters(width, height, graphState.directAdvisees, rootId);
  graphState.nodesById = new Map(nodes.map((node) => [node.id, node]));

  const nodeRadius = (node) => {
    const totalDesc = Math.max(0, node.total_descendants ?? 0);
    const compareMax = graphState.maxDescendants || 1;
    const normalized = normalizeValue(Math.sqrt(totalDesc), Math.sqrt(compareMax));
    const descendantBonus = 10 + normalized * 42;
    const directBonus = node.direct_advisee_count
      ? Math.min(11, Math.sqrt(node.direct_advisee_count) * 2.9)
      : 0;
    const computedRadius = Math.max(11, descendantBonus + directBonus);
    if (node.id === state.data.root) {
      return computedRadius * 1.15;
    }
    return computedRadius;
  };

  const zoom = d3
    .zoom()
    .scaleExtent([0.3, 4])
    .on("zoom", (event) => {
      graphState.currentTransform = event.transform;
      graphState.zoomLayer.attr("transform", event.transform);
    });
  svg.call(zoom).on("dblclick.zoom", null);
  svg.on("click", (event) => {
    // Ignore clicks that originated from nodes (they stop propagation)
    if (event.defaultPrevented) return;
    clearLineageHighlight();
    highlightGraphSelection(null);
  });
  graphState.zoom = zoom;
  graphState.currentTransform = d3.zoomIdentity;

  const drag = d3
    .drag()
    .on("start", (event, node) => {
      if (!event.active && graphState.simulation) {
        graphState.simulation.alphaTarget(0.3).restart();
      }
      node.fx = node.x;
      node.fy = node.y;
    })
    .on("drag", (event, node) => {
      node.fx = event.x;
      node.fy = event.y;
    })
    .on("end", (event, node) => {
      if (!event.active && graphState.simulation) {
        graphState.simulation.alphaTarget(0);
      }
      if (node.id === rootId) {
        node.fx = graphState.size.width / 2;
        node.fy = graphState.size.height / 2;
      } else {
        node.fx = null;
        node.fy = null;
      }
    });

  const linkSelection = linkGroup
    .selectAll("line")
    .data(links)
    .join("line")
    .attr("class", "graph-link")
    .attr("stroke-width", 1.2);

  const nodeSelection = nodeGroup
    .selectAll("g")
    .data(nodes, (node) => node.id)
    .join((enter) => {
      const group = enter.append("g").attr("class", "graph-node");
      group
        .append("circle")
        .attr("class", (node) => (node.id === rootId ? "graph-node-circle root" : "graph-node-circle"))
        .attr("r", (node) => nodeRadius(node))
        .attr("fill", (node) => pickDepthColor(node.depth))
        .attr("stroke", (node) => (node.id === rootId ? "#143166" : "#ffffff"))
        .attr("stroke-width", (node) => (node.id === rootId ? 3 : 1.5));
      group
        .append("text")
        .attr("class", "node-label")
        .attr("text-anchor", "middle")
        .attr("dy", (node) => nodeRadius(node) + 18)
        .text((node) => node.name);
      group
        .append("text")
        .attr("class", "hover-badge")
        .attr("text-anchor", "middle")
        .attr("dy", (node) => -nodeRadius(node) - 12)
        .text((node) => (node.depth === 0 ? "Root" : `Gen ${node.depth}`));
      group.append("title").text((node) => buildTooltip(node));
      return group;
    });

  nodeSelection
    .attr("tabindex", 0)
    .attr("role", "button")
    .call(drag)
    .on("click", (event, node) => {
      event.stopPropagation();
      selectNode(node.id);
    })
    .on("dblclick", (event, node) => {
      event.stopPropagation();
      openProfileLink(node);
    })
    .on("mouseover", (event, node) => {
      applyHoverHighlight(node.id);
    })
    .on("mouseout", () => {
      applyHoverHighlight(null);
    })
    .on("focus", (event, node) => {
      applyHoverHighlight(node.id);
    })
    .on("blur", () => {
      applyHoverHighlight(null);
    })
    .on("keydown", (event, node) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectNode(node.id, { focus: event.key === "Enter" });
      }
    });

  nodeSelection.classed("is-root", (node) => node.id === rootId);

  graphState.nodeSelection = nodeSelection;
  graphState.linkSelection = linkSelection;
  applyHoverHighlight(null);

  const linkDistance = (link) => {
    const sourceDepth =
      typeof link.source === "object" ? link.source.depth : depthById.get(link.source) ?? 0;
    const targetDepth =
      typeof link.target === "object" ? link.target.depth : depthById.get(link.target) ?? 0;
    let baseDistance;
    if (sourceDepth === 0) baseDistance = 220;
    else if (sourceDepth === 1 && targetDepth > 1) baseDistance = 160;
    else baseDistance = 90 + targetDepth * 30;

    const sourceNode = typeof link.source === "object" ? link.source : graphState.nodesById.get(link.source);
    const influenceBoost = normalizeInfluence(sourceNode, graphState.maxInfluence);
    const influenceMultiplier = 1 + influenceBoost * 0.6;
    return baseDistance * influenceMultiplier;
  };

  const simulation = d3
    .forceSimulation(nodes)
    .force("link", d3.forceLink(links).id((node) => node.id).distance(linkDistance).strength(0.9))
    .force("charge", d3.forceManyBody().strength(-220))
    .force("center", d3.forceCenter(width / 2, height / 2))
    .force("collide", d3.forceCollide().radius((node) => nodeRadius(node) + 14).strength(1.2))
    .force(
      "radial",
      d3.forceRadial((node) => radialRadius(node.depth), width / 2, height / 2).strength(0.3)
    )
    .force(
      "clusterX",
      d3.forceX((node) => getClusterTarget(node).x).strength((node) =>
        node.depth === 0 ? 0.62 : 0.15
      )
    )
    .force(
      "clusterY",
      d3.forceY((node) => getClusterTarget(node).y).strength((node) =>
        node.depth === 0 ? 0.62 : 0.15
      )
    )
    .alphaDecay(0.024)
    .on("tick", () => {
      linkSelection
        .attr("x1", (link) => link.source.x)
        .attr("y1", (link) => link.source.y)
        .attr("x2", (link) => link.target.x)
        .attr("y2", (link) => link.target.y);
      nodeSelection.attr("transform", (node) => `translate(${node.x}, ${node.y})`);
    });

  graphState.simulation = simulation;
  scheduleInitialFocus();

  const rootNode = graphState.nodesById.get(rootId);
  if (rootNode) {
    rootNode.fx = width / 2;
    rootNode.fy = height / 2;
  }

  if (typeof ResizeObserver !== "undefined") {
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target !== container) continue;
        const newWidth = entry.contentRect.width || container.clientWidth || width;
        const newHeight = entry.contentRect.height || container.clientHeight || height;
        if (!newWidth || !newHeight) continue;
        graphState.size = { width: newWidth, height: newHeight };
        svg.attr("viewBox", `0 0 ${newWidth} ${newHeight}`);
        graphState.clusterCenters = computeClusterCenters(
          newWidth,
          newHeight,
          graphState.directAdvisees,
          rootId
        );
        graphState.simulation
          .force("center", d3.forceCenter(newWidth / 2, newHeight / 2))
          .force(
            "radial",
            d3.forceRadial((node) => radialRadius(node.depth), newWidth / 2, newHeight / 2).strength(
              0.3
            )
          );
        const lockedRoot = graphState.nodesById.get(rootId);
        if (lockedRoot) {
          lockedRoot.fx = newWidth / 2;
          lockedRoot.fy = newHeight / 2;
        }
        graphState.simulation.alpha(0.35).restart();
        if (!graphState.initialFocusDone) {
          scheduleInitialFocus();
        } else {
          const currentScale = graphState.currentTransform?.k ?? 1;
          focusGraphNode(state.data.root, { scale: currentScale });
        }
      }
    });
    resizeObserver.observe(container);
    graphState.resizeObserver = resizeObserver;
  } else {
    console.warn("ResizeObserver not supported; graph will not adapt to container size changes.");
  }

  selectNode(state.data.root);
  console.timeEnd("initGraph");
};

const buildTooltip = (node) => {
  const affiliation = node.affiliationDisplay;
  const research =
    node.expertise_keywords && node.expertise_keywords.length
      ? node.expertise_keywords.slice(0, 4).join(", ")
      : "No research keywords listed";
  return [
    node.name,
    affiliation,
    `Direct PhD students: ${formatNumber(node.direct_advisee_count)} | PhD lineage: ${formatNumber(
      node.total_descendants
    )}`,
    research,
  ].join("\n");
};

const pickDepthColor = (depth) => {
  if (depth === 0) return "#1a3d8f";
  return depthColors[depth % depthColors.length];
};

const selectNode = (nodeId, options = {}) => {
  if (!nodeId) return;
  state.selectedNodeId = nodeId;

  const node = state.nodes.find((n) => n.id === nodeId);
  if (!node) return;

  updateLineageHighlight(nodeId);
  highlightGraphSelection(nodeId);
  if (options.focus) {
    const scale = nodeId === state.data.root ? 1.05 : 1.35;
    focusGraphNode(nodeId, { scale });
  }

  highlightRosterSelection();
  populateProfileCard(node);
  updatePreview(node);
};

const highlightRosterSelection = () => {
  const items = elements.rosterList.querySelectorAll("li");
  items.forEach((item) => {
    if (item.dataset.id === state.selectedNodeId) {
      item.classList.add("active");
      item.scrollIntoView({ block: "nearest", behavior: "smooth" });
    } else {
      item.classList.remove("active");
    }
  });
};

const populateProfileCard = (node) => {
  elements.profileCard.classList.remove("hidden");
  elements.profileName.textContent = node.name;
  elements.profileGeneration.textContent = depthLabel(node.depth);

  elements.profileAffiliation.textContent = node.affiliationDisplay ?? "—";
  elements.profileDescendants.textContent = formatNumber(node.total_descendants);
  elements.profileAdvisees.textContent = formatNumber(node.direct_advisee_count);

  if (node.expertise_keywords && node.expertise_keywords.length) {
    elements.profileResearch.innerHTML = node.expertise_keywords
      .map((keyword) => `<span class="tag">${keyword}</span>`)
      .join("");
  } else {
    elements.profileResearch.textContent = "No research keywords listed yet.";
  }

  const links = [];
  if (node.homepage) links.push(linkMarkup("Homepage", node.homepage));
  if (node.gscholar) links.push(linkMarkup("Google Scholar", node.gscholar));
  if (node.dblp) links.push(linkMarkup("DBLP", node.dblp));
  elements.profileLinks.innerHTML = links.length ? links.join(" · ") : "No public links available.";
};

const linkMarkup = (label, url) =>
  `<a href="${url}" target="_blank" rel="noopener">${label}</a>`;

const openProfileLink = (node) => {
  if (!node) return;
  const link = node.homepage || node.gscholar || node.dblp;
  if (link) {
    window.open(link, "_blank", "noopener");
  }
};

const updatePreview = (node) => {
  clearTimeout(previewLoadTimeout);
  elements.previewFrame.dataset.homepage = node.homepage || "";

  if (!node.homepage) {
    elements.previewCard.classList.remove("hidden");
    elements.previewFrame.classList.add("hidden");
    elements.previewFrame.src = "about:blank";
    elements.previewStatus.innerHTML =
      "No homepage listed yet. If you know one, please email <a href=\"mailto:prakashkagitha@gmail.com\">prakashkagitha@gmail.com</a>.";
    elements.previewRefresh.disabled = true;
    return;
  }

  elements.previewCard.classList.remove("hidden");
  elements.previewFrame.classList.remove("hidden");
  elements.previewStatus.textContent = "Loading preview…";
  elements.previewRefresh.disabled = false;

  try {
    elements.previewFrame.src = node.homepage;
  } catch (error) {
    handlePreviewError();
    return;
  }

  previewLoadTimeout = window.setTimeout(() => {
    elements.previewFrame.classList.add("hidden");
    elements.previewStatus.innerHTML = `This site blocks embedding or is taking too long. <a href="${node.homepage}" target="_blank" rel="noopener">Open homepage in a new tab</a>.`;
  }, 5000);
};

const handlePreviewRefresh = () => {
  if (!state.selectedNodeId) return;
  const node = state.nodes.find((n) => n.id === state.selectedNodeId);
  if (node) {
    updatePreview(node);
  }
};

const handlePreviewLoad = () => {
  clearTimeout(previewLoadTimeout);
  if (!elements.previewFrame.dataset.homepage) return;
  elements.previewFrame.classList.remove("hidden");
  elements.previewStatus.textContent = "";
};

const handlePreviewError = () => {
  clearTimeout(previewLoadTimeout);
  const homepage = elements.previewFrame.dataset.homepage;
  elements.previewFrame.classList.add("hidden");
  elements.previewStatus.innerHTML = homepage
    ? `Preview unavailable. <a href="${homepage}" target="_blank" rel="noopener">Open homepage in a new tab</a>.`
    : "";
};

const showGraphError = (error) => {
  const container = document.getElementById("network");
  if (!container) return;
  container.innerHTML = `
    <div class="graph-error">
      <h3>Graph failed to load</h3>
      <p>${error?.message || "Unexpected error occurred while rendering the visualization."}</p>
      <p>Please check the browser console for details and reload the page.</p>
    </div>
  `;
};

init();
