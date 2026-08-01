const adminApp = document.querySelector("#adminApp");
const candidateApp = document.querySelector("#candidateApp");
const loginPanel = document.querySelector("#loginPanel");
const dashboardPanel = document.querySelector("#dashboardPanel");
const logoutBtn = document.querySelector("#logoutBtn");
const apiStatus = document.querySelector("#apiStatus");
const toast = document.querySelector("#toast");
const viewTitle = document.querySelector("#viewTitle");
const createView = document.querySelector("#createView");
const interviewsView = document.querySelector("#interviewsView");
const reviewView = document.querySelector("#reviewView");
const promptsView = document.querySelector("#promptsView");
const interviewList = document.querySelector("#interviewList");
const reviewPanel = document.querySelector("#reviewPanel");
const promptList = document.querySelector("#promptList");
const promptForm = document.querySelector("#promptForm");
const promptEditorTitle = document.querySelector("#promptEditorTitle");
const promptTemplateSelect = document.querySelector("#promptTemplateSelect");
const createInterviewForm = document.querySelector("#createInterviewForm");
const createdInterviewPanel = document.querySelector("#createdInterviewPanel");
const generatedLink = document.querySelector("#generatedLink");
const generatedCode = document.querySelector("#generatedCode");
const candidateTitle = document.querySelector("#candidateTitle");
const accessPanel = document.querySelector("#accessPanel");
const chatPanel = document.querySelector("#chatPanel");
const messageList = document.querySelector("#messageList");
const timer = document.querySelector("#timer");
const candidateDonePanel = document.querySelector("#candidateDonePanel");
const submitInterviewBtn = document.querySelector("#submitInterviewBtn");
const submitInterviewBtnFooter = document.querySelector("#submitInterviewBtnFooter");
const interviewStatusLine = document.querySelector("#interviewStatusLine");
const openInterviewCount = document.querySelector("#openInterviewCount");
const reviewReadyCount = document.querySelector("#reviewReadyCount");
const promptTrackCount = document.querySelector("#promptTrackCount");

let adminToken = localStorage.getItem("admin_token") || "";
let candidateSession = "";
let activeInterviewId = "";
let activeInvite = null;
let countdownHandle = null;
let submitInFlight = false;
let promptTemplates = [];
let selectedPromptKey = "";

const params = new URLSearchParams(window.location.search);
const candidateInterviewId = params.get("interview");

function showToast(message) {
  toast.textContent = message;
  toast.classList.remove("hidden");
  window.setTimeout(() => toast.classList.add("hidden"), 3200);
}

async function api(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };

  if (adminToken && !headers.Authorization) {
    headers.Authorization = `Bearer ${adminToken}`;
  }

  const response = await fetch(path, {
    ...options,
    headers
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || "Request failed");
  }

  return payload;
}

function setApiStatus(text, className = "") {
  apiStatus.textContent = text;
  apiStatus.className = `status-pill ${className}`;
}

function formatDate(value) {
  if (!value) return "Not started";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function formatTimer(seconds) {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60).toString().padStart(2, "0");
  const rest = Math.floor(safe % 60).toString().padStart(2, "0");
  return `${minutes}:${rest}`;
}

function switchView(view) {
  const titles = {
    create: "Create interview",
    interviews: "Recent interviews",
    prompts: "Prompt library",
    review: "Review report"
  };

  viewTitle.textContent = titles[view] || titles.create;
  createView.classList.toggle("hidden", view !== "create");
  interviewsView.classList.toggle("hidden", view !== "interviews");
  promptsView.classList.toggle("hidden", view !== "prompts");
  reviewView.classList.toggle("hidden", view !== "review");

  document.querySelectorAll(".nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
}

function renderAdminShell() {
  adminApp.classList.remove("hidden");
  candidateApp.classList.add("hidden");
  const signedIn = Boolean(adminToken);
  loginPanel.classList.toggle("hidden", signedIn);
  dashboardPanel.classList.toggle("hidden", !signedIn);
  logoutBtn.classList.toggle("hidden", !signedIn);

  if (signedIn) {
    switchView("create");
    loadInterviews();
    loadPrompts();
  }
}

function interviewInviteText(invite) {
  return `Interview link: ${invite.link}\nUnique code: ${invite.code}`;
}

function setSubmitVisible(visible) {
  submitInterviewBtn.classList.toggle("hidden", !visible);
  submitInterviewBtnFooter.classList.toggle("hidden", !visible);
}

function setSubmitBusy(busy) {
  submitInterviewBtn.disabled = busy;
  submitInterviewBtnFooter.disabled = busy;
  submitInterviewBtn.textContent = busy ? "Submitting..." : "Submit interview";
  submitInterviewBtnFooter.textContent = busy ? "Submitting..." : "Submit interview";
}

function updateSummary(interviews = []) {
  const openCount = interviews.filter((interview) => ["pending", "active", "completed"].includes(interview.status)).length;
  const reviewCount = interviews.filter((interview) => interview.status === "reviewed").length;
  openInterviewCount.textContent = String(openCount);
  reviewReadyCount.textContent = String(reviewCount);
}

function updatePromptCount() {
  promptTrackCount.textContent = String(promptTemplates.filter((prompt) => prompt.active).length);
}

async function loadHealth() {
  try {
    const result = await api("/api/health", { headers: { Authorization: "" } });
    setApiStatus(result.mode === "mock" ? "Mock API" : "Production API", result.mode === "mock" ? "warn" : "ok");
  } catch (error) {
    setApiStatus("API offline", "warn");
  }
}

async function loadInterviews() {
  if (!adminToken) return;

  try {
    const result = await api("/api/interviews");
    renderInterviewList(result.interviews || []);
  } catch (error) {
    showToast(error.message);
  }
}

async function loadPrompts(preferredKey = selectedPromptKey) {
  if (!adminToken) return;

  try {
    const result = await api("/api/prompts");
    promptTemplates = result.prompts || [];
    selectedPromptKey = preferredKey && promptTemplates.some((prompt) => prompt.template_key === preferredKey)
      ? preferredKey
      : promptTemplates[0]?.template_key || "";
    updatePromptCount();
    populatePromptSelect();
    renderPromptList();
    renderPromptForm(promptTemplates.find((prompt) => prompt.template_key === selectedPromptKey) || null);
  } catch (error) {
    showToast(error.message);
  }
}

function populatePromptSelect() {
  const activePrompts = promptTemplates.filter((prompt) => prompt.active);
  const previousValue = promptTemplateSelect.value;
  promptTemplateSelect.innerHTML = activePrompts
    .map((prompt) => `<option value="${escapeHtml(prompt.template_key)}">${escapeHtml(prompt.title)} (${escapeHtml(prompt.role_type)})</option>`)
    .join("");

  if (activePrompts.some((prompt) => prompt.template_key === previousValue)) {
    promptTemplateSelect.value = previousValue;
  }
}

function renderPromptList() {
  if (!promptTemplates.length) {
    promptList.innerHTML = '<div class="empty-state">No prompt tracks yet.</div>';
    return;
  }

  promptList.innerHTML = promptTemplates
    .map((prompt) => `
      <button class="prompt-row ${prompt.template_key === selectedPromptKey ? "active" : ""}" type="button" data-prompt-key="${escapeHtml(prompt.template_key)}">
        <strong>${escapeHtml(prompt.title)}</strong>
        <span>${escapeHtml(prompt.template_key)} · ${escapeHtml(prompt.role_type)} · ${escapeHtml(prompt.active ? "active" : "inactive")}</span>
      </button>
    `)
    .join("");

  promptList.querySelectorAll("[data-prompt-key]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedPromptKey = button.dataset.promptKey;
      renderPromptList();
      renderPromptForm(promptTemplates.find((prompt) => prompt.template_key === selectedPromptKey) || null);
    });
  });
}

function renderPromptForm(prompt) {
  const isExisting = Boolean(prompt);
  const form = promptForm.elements;
  const fallback = {
    template_key: "",
    role_type: "",
    title: "",
    opening_question: "",
    body: "",
    active: true
  };
  const value = prompt || fallback;

  promptEditorTitle.textContent = isExisting ? value.title : "New track";
  form.template_key.value = value.template_key;
  form.template_key.readOnly = isExisting;
  form.role_type.value = value.role_type;
  form.title.value = value.title;
  form.opening_question.value = value.opening_question;
  form.body.value = value.body;
  form.active.checked = value.active !== false;
}

function renderInterviewList(interviews) {
  updateSummary(interviews);

  if (!interviews.length) {
    interviewList.innerHTML = '<div class="empty-state">No interviews yet. Create one to generate a candidate link.</div>';
    return;
  }

  interviewList.innerHTML = interviews
    .map((interview) => {
      const name = interview.candidate?.full_name || "Candidate";
      const topics = (interview.focus_topics || []).join(", ") || "No extra topics";
      return `
        <article class="interview-row">
          <div>
            <h4>${escapeHtml(name)} - ${escapeHtml(interview.role_label || interview.role_type)}</h4>
            <div class="meta-line">
              <span>${escapeHtml(interview.status)}</span>
              <span>${escapeHtml(String(interview.experience_years))} years</span>
              <span>${escapeHtml(topics)}</span>
              <span>${escapeHtml(formatDate(interview.created_at))}</span>
            </div>
          </div>
          <div class="button-row">
            <button class="secondary-button" type="button" data-review="${interview.id}">Review</button>
            <button class="secondary-button" type="button" data-copy-link="${interview.id}">Copy link</button>
          </div>
        </article>
      `;
    })
    .join("");

  interviewList.querySelectorAll("[data-review]").forEach((button) => {
    button.addEventListener("click", () => loadReview(button.dataset.review));
  });

  interviewList.querySelectorAll("[data-copy-link]").forEach((button) => {
    button.addEventListener("click", async () => {
      const link = `${window.location.origin}${window.location.pathname}?interview=${button.dataset.copyLink}`;
      await navigator.clipboard.writeText(link);
      showToast("Interview link copied.");
    });
  });
}

async function loadReview(interviewId) {
  switchView("review");
  reviewPanel.textContent = "Loading review...";

  try {
    const result = await api(`/api/interviews/${interviewId}/review`);
    renderReview(result.review);
  } catch (error) {
    reviewPanel.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }
}

function renderReview(review) {
  if (!review) {
    reviewPanel.innerHTML = '<div class="empty-state">No review is available yet. Completed interviews generate one automatically.</div>';
    return;
  }

  const result = review.result || review;
  reviewPanel.className = "form-panel wide";
  reviewPanel.innerHTML = `
    <div class="review-grid">
      ${scoreBox("Overall", result.overall_score)}
      ${scoreBox("Technical", result.technical_score)}
      ${scoreBox("Communication", result.communication_score)}
      ${scoreBox("Problem solving", result.problem_solving_score)}
    </div>
    <p><strong>Recommendation:</strong> ${escapeHtml(result.recommendation || "pending")}</p>
    <p>${escapeHtml(result.summary || "No summary provided.")}</p>
    ${listBlock("Strengths", result.strengths)}
    ${listBlock("Weaknesses", result.weaknesses)}
    ${listBlock("Red flags", result.red_flags)}
  `;
}

function scoreBox(label, value) {
  return `<div class="score-box"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value ?? "--"))}</strong></div>`;
}

function listBlock(title, items = []) {
  const safeItems = items.length ? items : ["None recorded."];
  return `<h4>${escapeHtml(title)}</h4><ul>${safeItems.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function renderMessages(messages) {
  messageList.innerHTML = messages
    .map((message) => `<div class="message ${message.role}">${escapeHtml(message.content)}</div>`)
    .join("");
  messageList.scrollTop = messageList.scrollHeight;
}

function startCountdown(seconds) {
  window.clearInterval(countdownHandle);
  let remaining = Number(seconds || 0);
  timer.textContent = formatTimer(remaining);

  countdownHandle = window.setInterval(async () => {
    remaining -= 1;
    timer.textContent = formatTimer(remaining);
    if (remaining <= 0) {
      window.clearInterval(countdownHandle);
      await finishCandidateInterview();
    }
  }, 1000);
}

async function finishCandidateInterview() {
  if (!candidateSession || !activeInterviewId) return;
  if (submitInFlight) return;

  submitInFlight = true;
  setSubmitBusy(true);
  interviewStatusLine.textContent = "Submitting";

  try {
    await api(`/api/interviews/${activeInterviewId}/finish`, {
      method: "POST",
      headers: { Authorization: `Bearer ${candidateSession}` }
    });
  } catch (error) {
    showToast(error.message);
    submitInFlight = false;
    setSubmitBusy(false);
    interviewStatusLine.textContent = "In progress";
    return;
  }

  window.clearInterval(countdownHandle);
  setSubmitVisible(false);
  chatPanel.classList.add("hidden");
  candidateDonePanel.classList.remove("hidden");
  timer.textContent = "Done";
}

function renderCandidateShell() {
  adminApp.classList.add("hidden");
  candidateApp.classList.remove("hidden");
  activeInterviewId = candidateInterviewId;
  timer.textContent = "--:--";
  setSubmitVisible(false);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

document.querySelector("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);

  try {
    const result = await api("/api/admin/login", {
      method: "POST",
      headers: { Authorization: "" },
      body: JSON.stringify({
        email: form.get("email"),
        password: form.get("password")
      })
    });

    adminToken = result.access_token;
    localStorage.setItem("admin_token", adminToken);
    renderAdminShell();
    showToast("Signed in.");
  } catch (error) {
    showToast(error.message);
  }
});

createInterviewForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);

  try {
    const result = await api("/api/interviews", {
      method: "POST",
      body: JSON.stringify({
        candidate: {
          full_name: form.get("full_name"),
          email: form.get("email"),
          age: form.get("age"),
          notes: form.get("notes")
        },
        role_type: form.get("role_type"),
        prompt_template_key: form.get("prompt_template_key"),
        experience_years: form.get("experience_years"),
        duration_minutes: form.get("duration_minutes"),
        focus_topics: form.get("focus_topics")
      })
    });

    activeInvite = result.invite;
    generatedLink.textContent = activeInvite.link;
    generatedCode.textContent = activeInvite.code;
    createdInterviewPanel.classList.remove("hidden");
    createView.classList.add("invite-visible");
    showToast("Interview created.");
    await loadInterviews();
  } catch (error) {
    showToast(error.message);
  }
});

createInterviewForm.addEventListener("reset", () => {
  activeInvite = null;
  createdInterviewPanel.classList.add("hidden");
  createView.classList.remove("invite-visible");
  generatedLink.textContent = "";
  generatedCode.textContent = "";
});

document.querySelector("#copyInviteBtn").addEventListener("click", async () => {
  if (!activeInvite) return;
  await navigator.clipboard.writeText(interviewInviteText(activeInvite));
  showToast("Invite copied.");
});

document.querySelector("#newPromptBtn").addEventListener("click", () => {
  selectedPromptKey = "";
  renderPromptList();
  renderPromptForm(null);
});

document.querySelector("#resetPromptBtn").addEventListener("click", () => {
  renderPromptForm(promptTemplates.find((prompt) => prompt.template_key === selectedPromptKey) || null);
});

promptForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const payload = {
    template_key: form.get("template_key"),
    role_type: form.get("role_type"),
    title: form.get("title"),
    opening_question: form.get("opening_question"),
    body: form.get("body"),
    active: form.get("active") === "on"
  };
  const existing = selectedPromptKey && promptTemplates.some((prompt) => prompt.template_key === selectedPromptKey);

  try {
    const result = await api(existing ? `/api/prompts/${selectedPromptKey}` : "/api/prompts", {
      method: existing ? "PATCH" : "POST",
      body: JSON.stringify(payload)
    });
    selectedPromptKey = result.prompt.template_key;
    showToast("Prompt saved.");
    await loadPrompts(selectedPromptKey);
  } catch (error) {
    showToast(error.message);
  }
});

document.querySelector("#candidateAccessForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);

  try {
    const result = await api("/api/interviews/verify", {
      method: "POST",
      headers: { Authorization: "" },
      body: JSON.stringify({
        interview_id: activeInterviewId,
        code: form.get("code")
      })
    });

    candidateSession = result.session_token;
    accessPanel.classList.add("hidden");
    chatPanel.classList.remove("hidden");
    candidateTitle.textContent = result.interview.role_label || "Interview session";
    interviewStatusLine.textContent = "In progress";
    setSubmitVisible(true);
    setSubmitBusy(false);
    renderMessages(result.messages || []);
    startCountdown(result.interview.seconds_remaining);
  } catch (error) {
    showToast(error.message);
  }
});

document.querySelector("#messageForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const message = String(form.get("message") || "").trim();
  if (!message) return;

  event.currentTarget.reset();
  const currentMessages = Array.from(messageList.querySelectorAll(".message")).map((node) => ({
    role: node.classList.contains("user") ? "user" : "assistant",
    content: node.textContent
  }));
  renderMessages([...currentMessages, { role: "user", content: message }]);

  try {
    const result = await api(`/api/interviews/${activeInterviewId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${candidateSession}` },
      body: JSON.stringify({ message })
    });

    renderMessages(result.messages || []);
    startCountdown(result.interview.seconds_remaining);
    if (result.interview.status === "completed" || result.interview.seconds_remaining <= 0) {
      await finishCandidateInterview();
    }
  } catch (error) {
    showToast(error.message);
  }
});

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => {
    switchView(button.dataset.view);
    if (button.dataset.view === "prompts") loadPrompts();
  });
});

document.querySelector("#refreshBtn").addEventListener("click", loadInterviews);

submitInterviewBtn.addEventListener("click", finishCandidateInterview);
submitInterviewBtnFooter.addEventListener("click", finishCandidateInterview);

logoutBtn.addEventListener("click", () => {
  adminToken = "";
  localStorage.removeItem("admin_token");
  renderAdminShell();
});

loadHealth();

if (candidateInterviewId) {
  renderCandidateShell();
} else {
  renderAdminShell();
}
