const state = {
  config: {},
  tokens: [],
  runners: [],
  templates: [],
  discovered: []
};

const $ = (selector) => document.querySelector(selector);

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  if (response.status === 204) return null;
  const contentType = response.headers.get("content-type") || "";
  return contentType.includes("application/json") ? response.json() : response.text();
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function runnerPayload(form) {
  const data = formData(form);
  return {
    name: data.name.trim(),
    tokenId: data.tokenId,
    image: data.image.trim(),
    labels: data.labels.trim(),
    volumeName: data.volumeName.trim(),
    containerName: data.containerName.trim(),
    mountDockerSocket: form.elements.mountDockerSocket.checked,
    runAsRoot: form.elements.runAsRoot.checked
  };
}

function renderTokens() {
  const tokenList = $("#tokens");
  const tokenSelect = $("#runner-form select[name='tokenId']");
  tokenList.innerHTML = "";
  tokenSelect.innerHTML = '<option value="">Select token</option>';

  for (const token of state.tokens) {
    const option = document.createElement("option");
    option.value = token.id;
    option.textContent = token.name;
    tokenSelect.append(option);

    const row = document.createElement("div");
    row.className = "token";
    row.innerHTML = `<div><strong>${escapeHtml(token.name)}</strong><div class="muted">${escapeHtml(token.token)}</div></div>`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "danger";
    button.textContent = "Delete";
    button.onclick = async () => {
      await api(`/tokens/${token.id}`, { method: "DELETE" });
      await load();
    };
    row.append(button);
    tokenList.append(row);
  }
}

function renderTemplates() {
  const select = $("#template-select");
  select.innerHTML = '<option value="">Templates</option>';
  state.templates.forEach((template, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = template.name;
    select.append(option);
  });
}

function renderRunners() {
  const list = $("#runners");
  list.innerHTML = "";

  if (!state.runners.length) {
    list.innerHTML = '<p class="muted">No runners yet.</p>';
    return;
  }

  for (const runner of state.runners) {
    const row = document.createElement("article");
    row.className = "runner";
    row.innerHTML = `
      <header>
        <div>
          <h3>${escapeHtml(runner.name)}</h3>
          <p class="muted">${escapeHtml(runner.containerName)}</p>
        </div>
        <span class="status ${escapeHtml(runner.status)}">${escapeHtml(runner.status)}</span>
      </header>
      <dl>
        <dt>Image</dt><dd>${escapeHtml(runner.image)}</dd>
        <dt>Volume</dt><dd>${escapeHtml(runner.volumeName)}</dd>
        <dt>Labels</dt><dd>${escapeHtml(runner.labels)}</dd>
        <dt>Docker socket</dt><dd>${runner.mountDockerSocket ? "mounted" : "not mounted"}</dd>
        <dt>User</dt><dd>${runner.runAsRoot ? "0:0" : "image default"}</dd>
      </dl>
    `;
    const actions = document.createElement("div");
    actions.className = "row-actions";
    actions.append(
      actionButton("Start", () => mutateRunner(runner.id, "start")),
      actionButton("Stop", () => mutateRunner(runner.id, "stop"), "secondary"),
      actionButton("Restart", () => mutateRunner(runner.id, "restart"), "secondary"),
      actionButton("Edit", () => editRunner(runner), "secondary"),
      actionButton("Logs / command", () => showDetails(runner), "secondary"),
      actionButton("Delete", () => deleteRunner(runner), "danger")
    );
    row.append(actions);
    list.append(row);
  }
}

function renderDiscovered() {
  const list = $("#discovered-runners");
  list.innerHTML = "";

  if (!state.discovered.length) {
    list.innerHTML = '<p class="muted">No scan results yet.</p>';
    return;
  }

  for (const runner of state.discovered) {
    const row = document.createElement("article");
    row.className = "runner";
    row.innerHTML = `
      <header>
        <div>
          <h3>${escapeHtml(runner.containerName)}</h3>
          <p class="muted">${escapeHtml(runner.image)}</p>
        </div>
        <span class="status ${escapeHtml(runner.status)}">${escapeHtml(runner.alreadyTracked ? "tracked" : runner.status)}</span>
      </header>
      <dl>
        <dt>Confidence</dt><dd>${escapeHtml(runner.confidence)}</dd>
        <dt>Volume</dt><dd>${escapeHtml(runner.volumeName)}</dd>
        <dt>Labels</dt><dd>${escapeHtml(runner.labels || "not inferred")}</dd>
        <dt>Docker socket</dt><dd>${runner.mountDockerSocket ? "mounted" : "not mounted"}</dd>
        <dt>User</dt><dd>${runner.runAsRoot ? "0:0/root" : "image default or unknown"}</dd>
        <dt>Notes</dt><dd>${escapeHtml(runner.notes.join(" ")) || "No issues detected."}</dd>
      </dl>
    `;

    const actions = document.createElement("div");
    actions.className = "row-actions";
    const button = actionButton(runner.alreadyTracked ? "Already tracked" : "Use in form", () => fillFormFromDiscovery(runner), "secondary");
    button.disabled = runner.alreadyTracked;
    actions.append(button);
    row.append(actions);
    list.append(row);
  }
}

function actionButton(label, onClick, className = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  if (className) button.className = className;
  button.onclick = onClick;
  return button;
}

async function mutateRunner(id, action) {
  await api(`/runners/${id}/${action}`, { method: "POST" });
  await load();
}

async function showDetails(runner) {
  const command = await api(`/runners/${runner.id}/command`, { headers: { Accept: "text/plain" } });
  const logs = await api(`/runners/${runner.id}/logs?tail=300`, { headers: { Accept: "text/plain" } });
  $("#details-title").textContent = runner.name;
  $("#command-output").textContent = command;
  $("#logs-output").textContent = logs || "No logs available.";
  $("#details-dialog").showModal();
}

function editRunner(runner) {
  const form = $("#runner-form");
  form.elements.id.value = runner.id;
  form.elements.name.value = runner.name;
  form.elements.tokenId.value = runner.tokenId;
  form.elements.image.value = runner.image;
  form.elements.labels.value = runner.labels;
  form.elements.volumeName.value = runner.volumeName;
  form.elements.containerName.value = runner.containerName;
  form.elements.mountDockerSocket.checked = runner.mountDockerSocket;
  form.elements.runAsRoot.checked = runner.runAsRoot;
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

function fillFormFromDiscovery(runner) {
  const form = $("#runner-form");
  const name = runner.containerName || "forgejo-runner";
  form.elements.id.value = "";
  form.elements.name.value = name;
  form.elements.image.value = runner.image || "data.forgejo.org/forgejo/runner:12";
  form.elements.labels.value = runner.labels || "";
  form.elements.volumeName.value = runner.volumeName || `${name}_data`;
  form.elements.containerName.value = runner.containerName;
  form.elements.mountDockerSocket.checked = runner.mountDockerSocket;
  form.elements.runAsRoot.checked = runner.runAsRoot;
  if (state.tokens[0]) {
    form.elements.tokenId.value = state.tokens[0].id;
  }
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function deleteRunner(runner) {
  if (!confirm(`Delete ${runner.name}? This removes the app record and managed container.`)) return;
  const removeVolume = confirm("Also remove the runner Docker volume? Keeping it preserves registration data for manual recovery.");
  await api(`/runners/${runner.id}?removeVolume=${removeVolume}`, { method: "DELETE" });
  await load();
}

function clearRunnerForm() {
  const form = $("#runner-form");
  form.reset();
  form.elements.id.value = "";
  form.elements.image.value = "data.forgejo.org/forgejo/runner:12";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function load() {
  const [config, tokens, runners, templates] = await Promise.all([
    api("/config"),
    api("/tokens"),
    api("/runners"),
    api("/templates")
  ]);
  state.config = config;
  state.tokens = tokens;
  state.runners = runners;
  state.templates = templates;

  $("#forgejo-url").value = config.forgejoUrl || "";
  renderTokens();
  renderTemplates();
  renderRunners();
  renderDiscovered();
}

$("#config-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await api("/config", { method: "PUT", body: JSON.stringify(formData(event.currentTarget)) });
  await load();
});

$("#token-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await api("/tokens", { method: "POST", body: JSON.stringify(formData(event.currentTarget)) });
  event.currentTarget.reset();
  await load();
});

$("#runner-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const id = event.currentTarget.elements.id.value;
  await api(id ? `/runners/${id}` : "/runners", {
    method: id ? "PUT" : "POST",
    body: JSON.stringify(runnerPayload(event.currentTarget))
  });
  clearRunnerForm();
  await load();
});

$("#template-select").addEventListener("change", (event) => {
  const template = state.templates[Number(event.currentTarget.value)];
  if (!template) return;
  const form = $("#runner-form");
  form.elements.labels.value = template.labels;
  form.elements.mountDockerSocket.checked = template.mountDockerSocket;
  form.elements.runAsRoot.checked = template.runAsRoot;
});

$("#reset-runner").addEventListener("click", clearRunnerForm);
$("#refresh").addEventListener("click", load);
$("#close-dialog").addEventListener("click", () => $("#details-dialog").close());
$("#discover-runners").addEventListener("click", async () => {
  state.discovered = await api("/runners/discover");
  renderDiscovered();
});

load().catch((error) => {
  document.body.insertAdjacentHTML("afterbegin", `<div class="warning">${escapeHtml(error.message)}</div>`);
});
