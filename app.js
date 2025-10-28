const state = {
  data: null,
  nodes: [],
  edges: [],
  filteredNodes: [],
  selectedNodeId: null,
};

let network = null;
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
  initGraph();
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
  const container = document.getElementById("network");

  const nodeById = new Map(state.nodes.map((node) => [node.id, node]));
  const depthGroups = new Map();
  state.nodes.forEach((node) => {
    if (!depthGroups.has(node.depth)) {
      depthGroups.set(node.depth, []);
    }
    depthGroups.get(node.depth).push(node.id);
  });

  const depthOrdering = new Map();
  depthGroups.forEach((ids, depth) => {
    ids.sort((a, b) => {
      const nameA = (nodeById.get(a)?.name || a).toLowerCase();
      const nameB = (nodeById.get(b)?.name || b).toLowerCase();
      return nameA.localeCompare(nameB);
    });
    ids.forEach((id, index) => {
      depthOrdering.set(id, { index, total: ids.length });
    });
  });

  const computePosition = (depth, index, total) => {
    if (depth === 0) {
      return { x: 0, y: 0 };
    }
    const arc = depth === 1 ? Math.PI * 1.2 : Math.PI * 1.8;
    const startAngle = -arc / 2;
    const angle =
      total === 1
        ? 0
        : startAngle +
          (index / (total - 1)) * arc +
          (depth > 2 ? (index % 2 === 0 ? 0.04 : -0.04) : 0);
    const radius = depth * 280;
    return {
      x: radius * Math.cos(angle),
      y: radius * Math.sin(angle),
    };
  };

  const nodesData = state.nodes.map((node) => {
    const { index = 0, total = 1 } = depthOrdering.get(node.id) || {};
    const depth = nodeById.get(node.id)?.depth ?? 0;
    const position = computePosition(depth, index, total);
    return {
      id: node.id,
      label: `${node.name}`,
      title: buildTooltip(node),
      color: pickDepthColor(node.depth),
      shape: "dot",
      size: node.id === state.data.root ? 26 : Math.min(16 + node.direct_advisee_count, 30),
      borderWidth: node.id === state.data.root ? 3 : 1,
      mass: Math.max(1, 6 - node.depth),
      x: position.x,
      y: position.y,
      font: {
        color: "#111829",
        face: "Inter, Arial",
        size: node.id === state.data.root ? 18 : 14,
        strokeWidth: 3,
        strokeColor: "#ffffff",
      },
    };
  });

  const edgesData = state.edges.map((edge) => ({
    ...edge,
    arrows: "to",
    color: { color: "#B6BED3" },
    smooth: { type: "cubicBezier", roundness: 0.3 },
  }));

  const options = {
    layout: {
      improvedLayout: true,
    },
    physics: {
      enabled: true,
      stabilization: {
        iterations: 250,
        updateInterval: 50,
        fit: true,
      },
      barnesHut: {
        gravitationalConstant: -2800,
        centralGravity: 0.08,
        springLength: 230,
        springConstant: 0.035,
        damping: 0.26,
        avoidOverlap: 1,
      },
    },
    interaction: {
      hover: true,
      tooltipDelay: 120,
      multiselect: false,
      navigationButtons: true,
    },
    edges: {
      arrows: {
        to: { enabled: true, scaleFactor: 0.6 },
      },
    },
  };

  network = new vis.Network(container, { nodes: nodesData, edges: edgesData }, options);

  network.once("stabilizationIterationsDone", () => {
    network.setOptions({ physics: false });
  });

  network.on("selectNode", (params) => {
    const nodeId = params.nodes[0];
    selectNode(nodeId);
  });

  network.on("doubleClick", (params) => {
    if (params.nodes?.length) {
      const node = state.nodes.find((n) => n.id === params.nodes[0]);
      openProfileLink(node);
    }
  });

  // focus root by default
  selectNode(state.data.root, { focus: true });
};

const buildTooltip = (node) => {
  const affiliation = node.affiliationDisplay;
  const research =
    node.expertise_keywords && node.expertise_keywords.length
      ? node.expertise_keywords.slice(0, 4).join(", ")
      : "No research keywords listed";
  return `
    <strong>${node.name}</strong><br />
    ${affiliation}<br />
    Direct PhD students: ${formatNumber(node.direct_advisee_count)} | PhD lineage: ${formatNumber(
    node.total_descendants
  )}<br />
    ${research}
  `;
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

  if (network) {
    network.selectNodes([nodeId]);
    if (options.focus) {
      network.focus(nodeId, {
        animation: { duration: 600, easingFunction: "easeInOutQuad" },
        scale: 1.2,
      });
    }
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

init();
