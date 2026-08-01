import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (!globalThis.btoa) globalThis.btoa = (value) => Buffer.from(value, "binary").toString("base64");
if (!globalThis.atob) globalThis.atob = (value) => Buffer.from(value, "base64").toString("binary");

const {
  addMinutes,
  createId,
  DEFAULT_PROMPT_TEMPLATES,
  firstQuestionFor,
  generateCode,
  hashCode,
  mockAssistantReply,
  mockReview,
  normalizePromptTemplate,
  parseTopics,
  secondsUntil,
  toPublicInterview,
  validateInterviewInput,
  validatePromptTemplateInput
} = await import("../src/core.js");

const rootDir = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const publicDir = join(rootDir, "public");
const port = Number(process.env.PORT || 8788);
const adminToken = "dev-admin-token";

const candidates = new Map();
const interviews = new Map();
const messages = new Map();
const reviews = new Map();
const sessions = new Map();
const promptTemplates = new Map(
  DEFAULT_PROMPT_TEMPLATES.map((template) => [
    template.template_key,
    {
      ...template,
      id: createId("prompt"),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }
  ])
);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function json(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function requireAdmin(req, res) {
  const header = req.headers.authorization || "";
  if (header !== `Bearer ${adminToken}`) {
    json(res, 401, { error: "Admin login required." });
    return false;
  }
  return true;
}

function requireCandidate(req, res, interviewId) {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const session = sessions.get(token);

  if (!session || session.interviewId !== interviewId || session.expiresAt < Date.now()) {
    json(res, 401, { error: "Interview session expired. Re-enter the access code." });
    return null;
  }

  return session;
}

function publicWithCandidate(interview) {
  return toPublicInterview(interview, candidates.get(interview.candidate_id), promptTemplates.get(interview.prompt_template_key));
}

function listPrompts() {
  return Array.from(promptTemplates.values()).sort((a, b) => a.title.localeCompare(b.title));
}

function listInterviews() {
  return Array.from(interviews.values())
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .map((interview) => ({
      ...publicWithCandidate(interview),
      created_at: interview.created_at
    }));
}

function ensureReview(interviewId) {
  if (reviews.has(interviewId)) return reviews.get(interviewId);

  const interview = interviews.get(interviewId);
  const candidate = candidates.get(interview.candidate_id);
  const transcript = messages.get(interviewId) || [];
  const review = {
    id: createId("review"),
    interview_id: interviewId,
    reviewer_model: "local-mock-reviewer",
    result: mockReview(interview, candidate, transcript),
    created_at: new Date().toISOString()
  };

  reviews.set(interviewId, review);
  interview.status = "reviewed";
  interview.updated_at = new Date().toISOString();
  return review;
}

async function handleApi(req, res, url) {
  const segments = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);

  if (req.method === "GET" && segments[0] === "health") {
    return json(res, 200, { ok: true, mode: "mock" });
  }

  if (req.method === "POST" && segments.join("/") === "admin/login") {
    const body = await readJson(req);
    if (!body.email || String(body.password || "").length < 4) {
      return json(res, 400, { error: "Enter an email and a password with at least 4 characters." });
    }

    return json(res, 200, {
      access_token: adminToken,
      user: { email: body.email, mode: "mock" }
    });
  }

  if (req.method === "GET" && segments[0] === "interviews" && segments.length === 1) {
    if (!requireAdmin(req, res)) return;
    return json(res, 200, { interviews: listInterviews() });
  }

  if (req.method === "GET" && segments[0] === "prompts" && segments.length === 1) {
    if (!requireAdmin(req, res)) return;
    return json(res, 200, { prompts: listPrompts() });
  }

  if (req.method === "POST" && segments[0] === "prompts" && segments.length === 1) {
    if (!requireAdmin(req, res)) return;

    const validation = validatePromptTemplateInput(await readJson(req));
    if (!validation.ok) return json(res, 400, { error: validation.errors.join(" ") });

    if (promptTemplates.has(validation.value.template_key)) {
      return json(res, 409, { error: "A prompt with this key already exists." });
    }

    const prompt = {
      ...validation.value,
      id: createId("prompt"),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    promptTemplates.set(prompt.template_key, prompt);
    return json(res, 201, { prompt });
  }

  if (["PATCH", "PUT"].includes(req.method || "") && segments[0] === "prompts" && segments.length === 2) {
    if (!requireAdmin(req, res)) return;

    const existing = promptTemplates.get(segments[1]);
    if (!existing) return json(res, 404, { error: "Prompt not found." });

    const body = await readJson(req);
    const validation = validatePromptTemplateInput({
      ...existing,
      ...body,
      template_key: existing.template_key
    });
    if (!validation.ok) return json(res, 400, { error: validation.errors.join(" ") });

    const prompt = {
      ...existing,
      ...normalizePromptTemplate(validation.value),
      id: existing.id,
      template_key: existing.template_key,
      created_at: existing.created_at,
      updated_at: new Date().toISOString()
    };
    promptTemplates.set(prompt.template_key, prompt);
    return json(res, 200, { prompt });
  }

  if (req.method === "POST" && segments[0] === "interviews" && segments.length === 1) {
    if (!requireAdmin(req, res)) return;

    const body = await readJson(req);
    const selectedPrompt = promptTemplates.get(String(body.prompt_template_key || ""));
    const validation = validateInterviewInput({
      ...body,
      role_type: selectedPrompt?.role_type || body.role_type,
      prompt_template_key: selectedPrompt?.template_key || body.prompt_template_key
    });
    if (!validation.ok) return json(res, 400, { error: validation.errors.join(" ") });

    const code = generateCode();
    const candidate = {
      id: createId("candidate"),
      ...validation.value.candidate,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    const interview = {
      id: createId("interview"),
      candidate_id: candidate.id,
      role_type: validation.value.role_type,
      experience_years: validation.value.experience_years,
      focus_topics: validation.value.focus_topics,
      duration_minutes: validation.value.duration_minutes,
      prompt_template_key: validation.value.prompt_template_key,
      code_hash: await hashCode(code),
      status: "pending",
      starts_at: null,
      ends_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    candidates.set(candidate.id, candidate);
    interviews.set(interview.id, interview);
    messages.set(interview.id, []);

    return json(res, 201, {
      interview: publicWithCandidate(interview),
      invite: {
        link: `${url.origin}/?interview=${interview.id}`,
        code
      }
    });
  }

  if (req.method === "POST" && segments.join("/") === "interviews/verify") {
    const body = await readJson(req);
    const interview = interviews.get(String(body.interview_id || ""));

    if (!interview || interview.code_hash !== (await hashCode(body.code))) {
      return json(res, 404, { error: "Invalid interview link or code." });
    }

    if (["completed", "reviewed", "expired"].includes(interview.status)) {
      return json(res, 409, { error: "This interview is already closed." });
    }

    if (!interview.starts_at) {
      interview.starts_at = new Date().toISOString();
      interview.ends_at = addMinutes(interview.starts_at, interview.duration_minutes);
      interview.status = "active";
      const candidate = candidates.get(interview.candidate_id);
      const promptTemplate = promptTemplates.get(interview.prompt_template_key);
      messages.set(interview.id, [
        {
          id: createId("msg"),
          role: "assistant",
          content: firstQuestionFor(interview, candidate, promptTemplate),
          created_at: new Date().toISOString()
        }
      ]);
    }

    const token = createId("session");
    sessions.set(token, {
      interviewId: interview.id,
      expiresAt: new Date(interview.ends_at).getTime() + 5 * 60_000
    });

    return json(res, 200, {
      session_token: token,
      interview: publicWithCandidate(interview),
      messages: messages.get(interview.id) || []
    });
  }

  if (segments[0] === "interviews" && segments.length >= 2) {
    const interviewId = segments[1];
    const interview = interviews.get(interviewId);
    if (!interview) return json(res, 404, { error: "Interview not found." });

    if (req.method === "POST" && segments[2] === "messages") {
      if (!requireCandidate(req, res, interviewId)) return;

      if (secondsUntil(interview.ends_at) <= 0) {
        interview.status = "completed";
        ensureReview(interview.id);
        return json(res, 200, {
          interview: publicWithCandidate(interview),
          messages: messages.get(interview.id) || []
        });
      }

      const body = await readJson(req);
      const content = String(body.message || "").trim();
      if (!content) return json(res, 400, { error: "Message is required." });

      const transcript = messages.get(interview.id) || [];
      transcript.push({
        id: createId("msg"),
        role: "user",
        content,
        created_at: new Date().toISOString()
      });
      transcript.push({
        id: createId("msg"),
        role: "assistant",
        content: mockAssistantReply(interview, transcript),
        created_at: new Date().toISOString()
      });
      messages.set(interview.id, transcript);

      return json(res, 200, {
        interview: publicWithCandidate(interview),
        messages: transcript
      });
    }

    if (req.method === "POST" && segments[2] === "finish") {
      if (!requireCandidate(req, res, interviewId)) return;
      interview.status = "completed";
      interview.ends_at = interview.ends_at || new Date().toISOString();
      interview.updated_at = new Date().toISOString();
      const review = ensureReview(interview.id);
      return json(res, 200, {
        interview: publicWithCandidate(interview),
        review
      });
    }

    if (req.method === "GET" && segments[2] === "review") {
      if (!requireAdmin(req, res)) return;
      return json(res, 200, { review: reviews.get(interview.id) || null });
    }
  }

  return json(res, 404, { error: "Route not found." });
}

async function serveStatic(req, res, url) {
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, safePath);

  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      "content-type": mimeTypes[extname(filePath)] || "application/octet-stream"
    });
    res.end(content);
  } catch {
    const content = await readFile(join(publicDir, "index.html"));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(content);
  }
}

async function smokeTest() {
  const origin = `http://localhost:${port}`;
  const login = await fetch(`${origin}/api/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "admin@example.com", password: "password" })
  }).then((res) => res.json());

  const created = await fetch(`${origin}/api/interviews`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${login.access_token}`
    },
    body: JSON.stringify({
      candidate: { full_name: "Test Candidate", email: "test@example.com" },
      role_type: "sde1",
      experience_years: 1,
      duration_minutes: 10,
      focus_topics: "arrays, debugging"
    })
  }).then((res) => res.json());

  const verified = await fetch(`${origin}/api/interviews/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      interview_id: created.interview.id,
      code: created.invite.code
    })
  }).then((res) => res.json());

  const message = await fetch(`${origin}/api/interviews/${created.interview.id}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${verified.session_token}`
    },
    body: JSON.stringify({ message: "I would use fast and slow pointers and explain the cycle condition." })
  }).then((res) => res.json());

  if (!message.messages || message.messages.length < 3) {
    throw new Error("Smoke test failed.");
  }

  console.log("Smoke test passed.");
}

const server = createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url).catch((error) => {
      console.error(error);
      json(res, 500, { error: "Unexpected server error." });
    });
    return;
  }

  serveStatic(req, res, url).catch((error) => {
    console.error(error);
    res.writeHead(500);
    res.end("Server error");
  });
});

server.listen(port, async () => {
  console.log(`AI Interview System running at http://localhost:${port}`);

  if (process.argv.includes("--smoke")) {
    try {
      await smokeTest();
      server.close();
    } catch (error) {
      console.error(error);
      server.close(() => process.exit(1));
    }
  }
});
