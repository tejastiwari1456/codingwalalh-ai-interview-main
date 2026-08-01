import {
  addMinutes,
  buildInterviewPrompt,
  buildReviewPrompt,
  firstQuestionFor,
  generateCode,
  hashCode,
  mockAssistantReply,
  mockReview,
  normalizePromptTemplate,
  signSession,
  toPublicInterview,
  validateInterviewInput,
  validatePromptTemplateInput,
  verifySession
} from "../../src/core.js";

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,authorization"
};

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function requireEnv(env: Record<string, string>, keys: string[]) {
  const missing = keys.filter((key) => !env[key]);
  if (missing.length) {
    throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  }
}

function bearer(request: Request) {
  return request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
}

async function readJson(request: Request) {
  return request.json().catch(() => ({}));
}

async function supabase(
  env: Record<string, string>,
  path: string,
  init: RequestInit = {},
  options: { token?: string; service?: boolean } = {}
) {
  requireEnv(env, ["SUPABASE_URL", "SUPABASE_ANON_KEY"]);
  if (options.service) requireEnv(env, ["SUPABASE_SERVICE_ROLE_KEY"]);

  const key = options.service ? env.SUPABASE_SERVICE_ROLE_KEY : env.SUPABASE_ANON_KEY;
  const response = await fetch(`${env.SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey: key,
      authorization: `Bearer ${options.service ? env.SUPABASE_SERVICE_ROLE_KEY : options.token || env.SUPABASE_ANON_KEY}`,
      "content-type": "application/json",
      prefer: "return=representation",
      ...(init.headers || {})
    }
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload?.message || payload?.error_description || payload?.error || "Supabase request failed.";
    throw new Error(message);
  }

  return payload;
}

async function getUser(env: Record<string, string>, token: string) {
  if (!token) throw new Error("Admin login required.");
  requireEnv(env, ["SUPABASE_URL", "SUPABASE_ANON_KEY"]);

  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      authorization: `Bearer ${token}`
    }
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error("Admin login required.");
  return payload;
}

function encodeQueryValue(value: string) {
  return encodeURIComponent(value).replace(/%20/g, "+");
}

async function loadInterviewBundle(env: Record<string, string>, interviewId: string) {
  const rows = await supabase(
    env,
    `/rest/v1/interviews?id=eq.${encodeQueryValue(interviewId)}&select=*,candidates(*)`,
    {},
    { service: true }
  );
  const interview = rows?.[0];
  if (!interview) throw new Error("Interview not found.");
  return {
    interview,
    candidate: interview.candidates
  };
}

async function loadPromptTemplate(env: Record<string, string>, templateKey: string, options: { token?: string; service?: boolean } = {}) {
  if (!templateKey) return null;

  const rows = await supabase(
    env,
    `/rest/v1/prompt_templates?template_key=eq.${encodeQueryValue(templateKey)}&select=*`,
    {},
    options.service ? { service: true } : { token: options.token }
  );

  return rows?.[0] || null;
}

async function loadMessages(env: Record<string, string>, interviewId: string) {
  return supabase(
    env,
    `/rest/v1/interview_messages?interview_id=eq.${encodeQueryValue(interviewId)}&select=*&order=created_at.asc`,
    {},
    { service: true }
  );
}

async function insertMessage(env: Record<string, string>, interviewId: string, role: string, content: string) {
  const rows = await supabase(
    env,
    "/rest/v1/interview_messages",
    {
      method: "POST",
      body: JSON.stringify({
        interview_id: interviewId,
        role,
        content
      })
    },
    { service: true }
  );

  return rows[0];
}

async function openAiText(env: Record<string, string>, model: string, instructions: string, input: unknown) {
  if (!env.OPENAI_API_KEY) return null;

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model,
      instructions,
      input
    })
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error?.message || "OpenAI request failed.");
  return payload?.output_text || payload?.output?.[0]?.content?.[0]?.text || "";
}

async function generateAssistantReply(
  env: Record<string, string>,
  interview: any,
  candidate: any,
  transcript: any[],
  promptTemplate: any
) {
  const input = transcript.map((message) => ({
    role: message.role === "assistant" ? "assistant" : "user",
    content: message.content
  }));

  const text = await openAiText(
    env,
    env.OPENAI_MODEL || "gpt-5.2",
    buildInterviewPrompt(interview, candidate, promptTemplate),
    input
  ).catch(() => null);

  return text || mockAssistantReply(interview, transcript);
}

async function generateReview(env: Record<string, string>, interview: any, candidate: any, transcript: any[]) {
  const reviewText = await openAiText(
    env,
    env.OPENAI_REVIEW_MODEL || env.OPENAI_MODEL || "gpt-5.2",
    buildReviewPrompt(interview, candidate),
    transcript.map((message) => `${message.role}: ${message.content}`).join("\n\n")
  ).catch(() => null);

  if (!reviewText) return mockReview(interview, candidate, transcript);

  try {
    return JSON.parse(reviewText);
  } catch {
    return {
      ...mockReview(interview, candidate, transcript),
      summary: reviewText
    };
  }
}

async function ensureReview(env: Record<string, string>, interview: any, candidate: any) {
  const existing = await supabase(
    env,
    `/rest/v1/interview_reviews?interview_id=eq.${encodeQueryValue(interview.id)}&select=*`,
    {},
    { service: true }
  );
  if (existing?.[0]) return existing[0];

  const transcript = await loadMessages(env, interview.id);
  const result = await generateReview(env, interview, candidate, transcript);
  const rows = await supabase(
    env,
    "/rest/v1/interview_reviews",
    {
      method: "POST",
      body: JSON.stringify({
        interview_id: interview.id,
        reviewer_model: env.OPENAI_REVIEW_MODEL || env.OPENAI_MODEL || "mock-reviewer",
        result
      })
    },
    { service: true }
  );

  await supabase(
    env,
    `/rest/v1/interviews?id=eq.${encodeQueryValue(interview.id)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ status: "reviewed" })
    },
    { service: true }
  );

  return rows[0];
}

export async function onRequest(context: { request: Request; env: Record<string, string> }) {
  const { request, env } = context;
  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const url = new URL(request.url);
  const segments = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);

  try {
    if (request.method === "GET" && segments[0] === "health") {
      return json({
        ok: true,
        mode: env.SUPABASE_URL && env.OPENAI_API_KEY ? "production" : "configured-partially"
      });
    }

    if (request.method === "POST" && segments.join("/") === "admin/login") {
      requireEnv(env, ["SUPABASE_URL", "SUPABASE_ANON_KEY"]);
      const body = await readJson(request);
      const response = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: {
          apikey: env.SUPABASE_ANON_KEY,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          email: body.email,
          password: body.password
        })
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) return json({ error: payload?.error_description || "Invalid login." }, 401);
      return json(payload);
    }

    if (request.method === "GET" && segments[0] === "interviews" && segments.length === 1) {
      const token = bearer(request);
      await getUser(env, token);
      const rows = await supabase(
        env,
        "/rest/v1/interviews?select=*,candidates(*),prompt_templates(*)&order=created_at.desc",
        {},
        { token }
      );
      return json({
        interviews: rows.map((row: any) => ({
          ...toPublicInterview(row, row.candidates, row.prompt_templates),
          created_at: row.created_at
        }))
      });
    }

    if (request.method === "GET" && segments[0] === "prompts" && segments.length === 1) {
      const token = bearer(request);
      await getUser(env, token);
      const rows = await supabase(
        env,
        "/rest/v1/prompt_templates?select=*&order=title.asc",
        {},
        { token }
      );
      return json({ prompts: rows });
    }

    if (request.method === "POST" && segments[0] === "prompts" && segments.length === 1) {
      const token = bearer(request);
      await getUser(env, token);
      const validation = validatePromptTemplateInput(await readJson(request));
      if (!validation.ok) return json({ error: validation.errors.join(" ") }, 400);

      const rows = await supabase(
        env,
        "/rest/v1/prompt_templates",
        {
          method: "POST",
          body: JSON.stringify(validation.value)
        },
        { token }
      );

      return json({ prompt: rows[0] }, 201);
    }

    if (["PATCH", "PUT"].includes(request.method) && segments[0] === "prompts" && segments.length === 2) {
      const token = bearer(request);
      await getUser(env, token);
      const existing = await loadPromptTemplate(env, segments[1], { token });
      if (!existing) return json({ error: "Prompt not found." }, 404);

      const validation = validatePromptTemplateInput({
        ...existing,
        ...(await readJson(request)),
        template_key: existing.template_key
      });
      if (!validation.ok) return json({ error: validation.errors.join(" ") }, 400);

      const rows = await supabase(
        env,
        `/rest/v1/prompt_templates?template_key=eq.${encodeQueryValue(existing.template_key)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            ...normalizePromptTemplate(validation.value),
            template_key: existing.template_key
          })
        },
        { token }
      );

      return json({ prompt: rows[0] });
    }

    if (request.method === "POST" && segments[0] === "interviews" && segments.length === 1) {
      const token = bearer(request);
      const user = await getUser(env, token);
      const body = await readJson(request);
      const selectedPrompt = await loadPromptTemplate(env, String(body.prompt_template_key || ""), { token });
      const validation = validateInterviewInput({
        ...body,
        role_type: selectedPrompt?.role_type || body.role_type,
        prompt_template_key: selectedPrompt?.template_key || body.prompt_template_key
      });
      if (!validation.ok) return json({ error: validation.errors.join(" ") }, 400);

      const code = generateCode();
      const candidateRows = await supabase(
        env,
        "/rest/v1/candidates",
        {
          method: "POST",
          body: JSON.stringify({
            ...validation.value.candidate,
            created_by: user.id
          })
        },
        { token }
      );

      const interviewRows = await supabase(
        env,
        "/rest/v1/interviews",
        {
          method: "POST",
          body: JSON.stringify({
            created_by: user.id,
            candidate_id: candidateRows[0].id,
            role_type: validation.value.role_type,
            experience_years: validation.value.experience_years,
            focus_topics: validation.value.focus_topics,
            duration_minutes: validation.value.duration_minutes,
            prompt_template_key: validation.value.prompt_template_key,
            code_hash: await hashCode(code),
            status: "pending"
          })
        },
        { token }
      );

      return json(
        {
          interview: toPublicInterview(interviewRows[0], candidateRows[0], selectedPrompt),
          invite: {
            link: `${url.origin}/?interview=${interviewRows[0].id}`,
            code
          }
        },
        201
      );
    }

    if (request.method === "POST" && segments.join("/") === "interviews/verify") {
      requireEnv(env, ["INTERVIEW_SESSION_SECRET"]);
      const body = await readJson(request);
      const { interview, candidate } = await loadInterviewBundle(env, String(body.interview_id || ""));

      if (interview.code_hash !== (await hashCode(body.code))) {
        return json({ error: "Invalid interview link or code." }, 404);
      }

      if (["completed", "reviewed", "expired"].includes(interview.status)) {
        return json({ error: "This interview is already closed." }, 409);
      }

      let activeInterview = interview;
      let transcript = await loadMessages(env, interview.id);
      const promptTemplate = await loadPromptTemplate(env, interview.prompt_template_key, { service: true });

      if (!interview.starts_at) {
        const startsAt = new Date().toISOString();
        const endsAt = addMinutes(startsAt, interview.duration_minutes);
        const rows = await supabase(
          env,
          `/rest/v1/interviews?id=eq.${encodeQueryValue(interview.id)}`,
          {
            method: "PATCH",
            body: JSON.stringify({
              status: "active",
              starts_at: startsAt,
              ends_at: endsAt
            })
          },
          { service: true }
        );
        activeInterview = rows[0];
        await insertMessage(env, interview.id, "assistant", firstQuestionFor(activeInterview, candidate, promptTemplate));
        transcript = await loadMessages(env, interview.id);
      }

      const sessionToken = await signSession(
        {
          interview_id: interview.id,
          exp: Math.floor(new Date(activeInterview.ends_at).getTime() / 1000) + 300
        },
        env.INTERVIEW_SESSION_SECRET
      );

      return json({
        session_token: sessionToken,
        interview: toPublicInterview(activeInterview, candidate, promptTemplate),
        messages: transcript
      });
    }

    if (segments[0] === "interviews" && segments.length >= 2) {
      const interviewId = segments[1];
      const { interview, candidate } = await loadInterviewBundle(env, interviewId);
      const promptTemplate = await loadPromptTemplate(env, interview.prompt_template_key, { service: true });

      if (request.method === "POST" && segments[2] === "messages") {
        requireEnv(env, ["INTERVIEW_SESSION_SECRET"]);
        const session = await verifySession(bearer(request), env.INTERVIEW_SESSION_SECRET);
        if (!session || session.interview_id !== interviewId) return json({ error: "Interview session expired." }, 401);

        if (interview.ends_at && new Date(interview.ends_at).getTime() <= Date.now()) {
          await ensureReview(env, interview, candidate);
          return json({
            interview: toPublicInterview({ ...interview, status: "reviewed" }, candidate, promptTemplate),
            messages: await loadMessages(env, interview.id)
          });
        }

        const body = await readJson(request);
        const content = String(body.message || "").trim();
        if (!content) return json({ error: "Message is required." }, 400);

        await insertMessage(env, interview.id, "user", content);
        const transcriptAfterUser = await loadMessages(env, interview.id);
        const reply = await generateAssistantReply(env, interview, candidate, transcriptAfterUser, promptTemplate);
        await insertMessage(env, interview.id, "assistant", reply);
        const transcript = await loadMessages(env, interview.id);

        return json({
          interview: toPublicInterview(interview, candidate, promptTemplate),
          messages: transcript
        });
      }

      if (request.method === "POST" && segments[2] === "finish") {
        requireEnv(env, ["INTERVIEW_SESSION_SECRET"]);
        const session = await verifySession(bearer(request), env.INTERVIEW_SESSION_SECRET);
        if (!session || session.interview_id !== interviewId) return json({ error: "Interview session expired." }, 401);

        await supabase(
          env,
          `/rest/v1/interviews?id=eq.${encodeQueryValue(interview.id)}`,
          {
            method: "PATCH",
            body: JSON.stringify({
              status: "completed",
              ends_at: interview.ends_at || new Date().toISOString()
            })
          },
          { service: true }
        );
        const review = await ensureReview(env, interview, candidate);
        return json({ interview: toPublicInterview({ ...interview, status: "reviewed" }, candidate, promptTemplate), review });
      }

      if (request.method === "GET" && segments[2] === "review") {
        const token = bearer(request);
        await getUser(env, token);
        const rows = await supabase(
          env,
          `/rest/v1/interview_reviews?interview_id=eq.${encodeQueryValue(interview.id)}&select=*`,
          {},
          { token }
        );
        return json({ review: rows?.[0] || null });
      }
    }

    return json({ error: "Route not found." }, 404);
  } catch (error: any) {
    return json({ error: error.message || "Unexpected API error." }, 500);
  }
}
