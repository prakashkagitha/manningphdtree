const state = {
  data: null,
  nodes: [],
  edges: [],
  filteredNodes: [],
  selectedNodeId: null,
};

let network = null;

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
};

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
  if (depth === 1) return "Generation 1 (Direct advisee)";
  return `Generation ${depth}`;
};

const populateSummary = () => {
  const {
    summary: { total_nodes, direct_advisees, max_depth, depth_counts, generated_from },
    nodes,
  } = state.data;

  elements.summaryTotalNodes.textContent = total_nodes;
  elements.summaryDirectAdvisees.textContent = direct_advisees;
  elements.summaryDepth.textContent = `${max_depth + 1}`;

  const uniqueInstitutions = new Set(
    nodes
      .map((n) => n.affiliation_name || n.affiliation_domain)
      .filter(Boolean)
  );
  elements.summaryInstitutions.textContent = uniqueInstitutions.size || "–";

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
    .map(([depth, count]) => `Generation ${depth}: ${count}`)
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
        ${node.affiliationDisplay} • Advisees: ${node.direct_advisee_count} • Gen ${node.depth}
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
  const nodesData = state.nodes.map((node) => ({
    id: node.id,
    label: `${node.name}`,
    title: buildTooltip(node),
    color: pickDepthColor(node.depth),
    shape: "dot",
    size: node.id === state.data.root ? 24 : Math.min(18 + node.direct_advisee_count, 32),
    borderWidth: node.id === state.data.root ? 3 : 1,
    font: {
      color: "#111829",
      face: "Inter, Arial",
      size: node.id === state.data.root ? 18 : 14,
    },
  }));

  const edgesData = state.edges.map((edge) => ({
    ...edge,
    arrows: "to",
    color: { color: "#CDD3E2" },
    smooth: { type: "cubicBezier", roundness: 0.4 },
  }));

  const options = {
    layout: {
      improvedLayout: true,
    },
    physics: {
      stabilization: true,
      barnesHut: {
        gravitationalConstant: -2000,
        centralGravity: 0.095,
        springLength: 140,
        springConstant: 0.04,
      },
    },
    interaction: {
      hover: true,
      tooltipDelay: 120,
      multiselect: false,
    },
    edges: {
      arrows: {
        to: { enabled: true, scaleFactor: 0.6 },
      },
    },
  };

  network = new vis.Network(container, { nodes: nodesData, edges: edgesData }, options);

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
    Advisees: ${node.direct_advisee_count} | Descendants: ${node.total_descendants}<br />
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
  elements.profileDescendants.textContent = node.total_descendants ?? "0";
  elements.profileAdvisees.textContent = node.direct_advisee_count ?? "0";

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

init();
