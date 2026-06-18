import { createServer } from "node:http";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { defaultData } from "./seed-data.mjs";

const scrypt = promisify(scryptCallback);
const root = dirname(fileURLToPath(import.meta.url));
const publicRoot = join(root, "public");
const dataPath = process.env.DATA_PATH ? resolve(process.env.DATA_PATH) : join(root, "data", "db.json");
const port = Number(process.env.PORT || 5173);
const sessions = new Map();
const loginAttempts = new Map();
const SESSION_MS = 1000 * 60 * 60 * 24 * 7;
const MAX_BODY = 250_000;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon"
};

let db = await loadDatabase();
await ensureAdmin();

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || `localhost:${port}`}`);
    setSecurityHeaders(response);

    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      sendJson(response, 405, { error: "Метод не поддерживается" });
      return;
    }
    await serveStatic(url.pathname, response, request.method === "HEAD");
  } catch (error) {
    console.error(error);
    if (!response.headersSent) sendJson(response, error.status || 500, { error: error.publicMessage || "Ошибка сервера" });
    else response.end();
  }
});

server.listen(port, () => {
  console.log(`\nMentoria Hub запущен: http://localhost:${port}`);
  if (!process.env.ADMIN_PASSWORD) {
    console.log("Демо-администратор: admin@mentoria.local / ChangeMeMentoria2026!");
    console.log("Для публикации задайте ADMIN_EMAIL и ADMIN_PASSWORD.\n");
  }
});

async function handleApi(request, response, url) {
  const path = url.pathname;
  const method = request.method;
  const user = currentUser(request);

  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) assertSameOrigin(request);

  if (method === "GET" && path === "/api/health") {
    sendJson(response, 200, { ok: true, service: "Mentoria Hub", time: new Date().toISOString() });
    return;
  }

  if (method === "POST" && path === "/api/auth/register") {
    const body = await readJson(request);
    const name = clean(body.name, 80);
    const email = normalizeEmail(body.email);
    const password = String(body.password || "");
    const grade = String(body.grade || "");
    const interests = cleanArray(body.interests, 8, 40);
    if (name.length < 2) throw badRequest("Укажите имя — минимум 2 символа");
    if (!isEmail(email)) throw badRequest("Введите корректный email");
    if (!/^(8|9|10|11)$/.test(grade)) throw badRequest("Выберите класс с 8 по 11");
    validatePassword(password);
    if (db.users.some((item) => item.email === email)) throw conflict("Пользователь с таким email уже существует");
    const newUser = {
      id: id("usr"),
      name,
      email,
      passwordHash: await hashPassword(password),
      role: "student",
      grade,
      country: clean(body.country || "Казахстан", 60),
      interests,
      goals: cleanArray(body.goals, 6, 60),
      savedOpportunityIds: [],
      enrolledCourseIds: [],
      completedLessons: {},
      createdAt: new Date().toISOString()
    };
    db.users.push(newUser);
    await persist();
    createSession(response, newUser);
    sendJson(response, 201, { user: publicUser(newUser) });
    return;
  }

  if (method === "POST" && path === "/api/auth/login") {
    enforceLoginRate(request);
    const body = await readJson(request);
    const email = normalizeEmail(body.email);
    const account = db.users.find((item) => item.email === email);
    const valid = account ? await verifyPassword(String(body.password || ""), account.passwordHash) : false;
    if (!valid) {
      recordFailedLogin(request);
      throw unauthorized("Неверный email или пароль");
    }
    clearFailedLogins(request);
    createSession(response, account);
    sendJson(response, 200, { user: publicUser(account) });
    return;
  }

  if (method === "POST" && path === "/api/auth/logout") {
    const token = cookieMap(request).mh_session;
    if (token) sessions.delete(token);
    response.setHeader("Set-Cookie", "mh_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    sendJson(response, 200, { ok: true });
    return;
  }

  if (method === "GET" && path === "/api/auth/me") {
    sendJson(response, 200, { user: user ? publicUser(user) : null });
    return;
  }

  if (method === "PATCH" && path === "/api/profile") {
    requireUser(user);
    const body = await readJson(request);
    if (body.name !== undefined) {
      const value = clean(body.name, 80);
      if (value.length < 2) throw badRequest("Имя слишком короткое");
      user.name = value;
    }
    if (body.grade !== undefined) {
      const value = String(body.grade);
      if (!/^(8|9|10|11)$/.test(value)) throw badRequest("Некорректный класс");
      user.grade = value;
    }
    if (body.country !== undefined) user.country = clean(body.country, 60);
    if (body.interests !== undefined) user.interests = cleanArray(body.interests, 8, 40);
    if (body.goals !== undefined) user.goals = cleanArray(body.goals, 6, 60);
    await persist();
    sendJson(response, 200, { user: publicUser(user) });
    return;
  }

  if (method === "GET" && path === "/api/opportunities") {
    const result = filterOpportunities(url.searchParams);
    sendJson(response, 200, { opportunities: result, savedIds: user?.savedOpportunityIds || [] });
    return;
  }

  const opportunityDetail = path.match(/^\/api\/opportunities\/([^/]+)$/);
  if (method === "GET" && opportunityDetail) {
    const item = findOpportunity(decodeURIComponent(opportunityDetail[1]));
    sendJson(response, 200, { opportunity: item, saved: Boolean(user?.savedOpportunityIds.includes(item.id)) });
    return;
  }

  const saveMatch = path.match(/^\/api\/opportunities\/([^/]+)\/save$/);
  if (method === "POST" && saveMatch) {
    requireUser(user);
    const item = findOpportunity(decodeURIComponent(saveMatch[1]));
    const saved = user.savedOpportunityIds.includes(item.id);
    user.savedOpportunityIds = saved
      ? user.savedOpportunityIds.filter((entry) => entry !== item.id)
      : [...user.savedOpportunityIds, item.id];
    await persist();
    sendJson(response, 200, { saved: !saved, savedIds: user.savedOpportunityIds });
    return;
  }

  if (method === "GET" && path === "/api/courses") {
    sendJson(response, 200, { courses: db.courses.map(courseSummary), enrolledIds: user?.enrolledCourseIds || [] });
    return;
  }

  const courseDetail = path.match(/^\/api\/courses\/([^/]+)$/);
  if (method === "GET" && courseDetail) {
    const course = findCourse(decodeURIComponent(courseDetail[1]));
    sendJson(response, 200, {
      course,
      enrolled: Boolean(user?.enrolledCourseIds.includes(course.id)),
      completedLessons: user?.completedLessons[course.id] || []
    });
    return;
  }

  const enrollMatch = path.match(/^\/api\/courses\/([^/]+)\/enroll$/);
  if (method === "POST" && enrollMatch) {
    requireUser(user);
    const course = findCourse(decodeURIComponent(enrollMatch[1]));
    if (!user.enrolledCourseIds.includes(course.id)) user.enrolledCourseIds.push(course.id);
    user.completedLessons[course.id] ||= [];
    await persist();
    sendJson(response, 200, { enrolled: true });
    return;
  }

  const lessonMatch = path.match(/^\/api\/courses\/([^/]+)\/lessons\/([^/]+)\/complete$/);
  if (method === "POST" && lessonMatch) {
    requireUser(user);
    const course = findCourse(decodeURIComponent(lessonMatch[1]));
    const lessonId = decodeURIComponent(lessonMatch[2]);
    if (!user.enrolledCourseIds.includes(course.id)) throw badRequest("Сначала запишитесь на курс");
    if (!course.lessons.some((lesson) => lesson.id === lessonId)) throw notFound("Урок не найден");
    const done = user.completedLessons[course.id] ||= [];
    const completed = done.includes(lessonId);
    user.completedLessons[course.id] = completed ? done.filter((entry) => entry !== lessonId) : [...done, lessonId];
    await persist();
    sendJson(response, 200, { completed: !completed, completedLessons: user.completedLessons[course.id] });
    return;
  }

  if (method === "GET" && path === "/api/dashboard") {
    requireUser(user);
    const saved = user.savedOpportunityIds.map((itemId) => db.opportunities.find((item) => item.id === itemId)).filter(Boolean);
    const courses = user.enrolledCourseIds.map((itemId) => db.courses.find((item) => item.id === itemId)).filter(Boolean).map((course) => ({
      ...courseSummary(course),
      completed: (user.completedLessons[course.id] || []).length,
      total: course.lessons.length,
      progress: Math.round(((user.completedLessons[course.id] || []).length / course.lessons.length) * 100)
    }));
    sendJson(response, 200, {
      user: publicUser(user),
      saved: saved.sort((a, b) => new Date(a.deadline) - new Date(b.deadline)),
      courses,
      recommendations: recommendedOpportunities(user, 4),
      stats: {
        saved: saved.length,
        activeCourses: courses.length,
        completedLessons: courses.reduce((total, course) => total + course.completed, 0),
        nextDeadline: saved.find((item) => new Date(item.deadline) > new Date()) || null
      }
    });
    return;
  }

  if (method === "GET" && path === "/api/chat/messages") {
    requireUser(user);
    const room = ["general", "stem", "admissions"].includes(url.searchParams.get("room")) ? url.searchParams.get("room") : "general";
    const since = url.searchParams.get("since");
    const messages = db.messages.filter((item) => item.room === room && (!since || new Date(item.createdAt) > new Date(since))).slice(-100);
    sendJson(response, 200, { room, messages });
    return;
  }

  if (method === "POST" && path === "/api/chat/messages") {
    requireUser(user);
    const body = await readJson(request);
    const room = ["general", "stem", "admissions"].includes(body.room) ? body.room : "general";
    const text = clean(body.text, 800);
    if (text.length < 1) throw badRequest("Сообщение пустое");
    const recent = db.messages.filter((item) => item.userId === user.id && Date.now() - new Date(item.createdAt).getTime() < 10_000);
    if (recent.length >= 5) throw tooMany("Слишком много сообщений — сделайте короткую паузу");
    const message = { id: id("msg"), room, userId: user.id, name: user.name, role: user.role, text, createdAt: new Date().toISOString() };
    db.messages.push(message);
    db.messages = db.messages.slice(-1000);
    await persist();
    sendJson(response, 201, { message });
    return;
  }

  if (method === "POST" && path === "/api/mentor-ai") {
    requireUser(user);
    const body = await readJson(request);
    const message = clean(body.message, 1000);
    if (!message) throw badRequest("Напишите вопрос");
    const answer = process.env.OPENAI_API_KEY ? await openAiAnswer(user, message) : demoMentorAnswer(user, message);
    sendJson(response, 200, answer);
    return;
  }

  if (method === "GET" && path === "/api/admin/stats") {
    requireAdmin(user);
    sendJson(response, 200, {
      users: db.users.map(publicUser),
      stats: {
        users: db.users.filter((item) => item.role === "student").length,
        saved: db.users.reduce((total, item) => total + item.savedOpportunityIds.length, 0),
        enrollments: db.users.reduce((total, item) => total + item.enrolledCourseIds.length, 0),
        messages: db.messages.filter((item) => item.userId !== "system").length
      }
    });
    return;
  }

  const adminUserRole = path.match(/^\/api\/admin\/users\/([^/]+)\/role$/);
  if (method === "PATCH" && adminUserRole) {
    requireAdmin(user);
    const targetId = decodeURIComponent(adminUserRole[1]);
    const target = db.users.find((item) => item.id === targetId);
    if (!target) throw notFound("Пользователь не найден");
    const body = await readJson(request);
    const role = body.role === "admin" ? "admin" : body.role === "student" ? "student" : null;
    if (!role) throw badRequest("Допустимые роли: admin или student");
    if (target.id === user.id && role !== "admin") throw badRequest("Нельзя снять права у собственного аккаунта");
    if (target.role === "admin" && role !== "admin" && db.users.filter((item) => item.role === "admin").length <= 1) {
      throw badRequest("В системе должен остаться хотя бы один администратор");
    }
    target.role = role;
    await persist();
    sendJson(response, 200, { user: publicUser(target) });
    return;
  }

  if (method === "POST" && path === "/api/admin/opportunities") {
    requireAdmin(user);
    const body = await readJson(request);
    const item = normalizeOpportunity(body, body.id || slug(body.title));
    if (db.opportunities.some((entry) => entry.id === item.id)) throw conflict("Такой ID уже существует");
    db.opportunities.unshift(item);
    await persist();
    sendJson(response, 201, { opportunity: item });
    return;
  }

  const adminOpportunity = path.match(/^\/api\/admin\/opportunities\/([^/]+)$/);
  if (method === "PUT" && adminOpportunity) {
    requireAdmin(user);
    const targetId = decodeURIComponent(adminOpportunity[1]);
    const index = db.opportunities.findIndex((item) => item.id === targetId);
    if (index < 0) throw notFound("Возможность не найдена");
    db.opportunities[index] = normalizeOpportunity(await readJson(request), targetId);
    await persist();
    sendJson(response, 200, { opportunity: db.opportunities[index] });
    return;
  }
  if (method === "DELETE" && adminOpportunity) {
    requireAdmin(user);
    const targetId = decodeURIComponent(adminOpportunity[1]);
    const originalLength = db.opportunities.length;
    db.opportunities = db.opportunities.filter((item) => item.id !== targetId);
    if (db.opportunities.length === originalLength) throw notFound("Возможность не найдена");
    for (const account of db.users) account.savedOpportunityIds = account.savedOpportunityIds.filter((item) => item !== targetId);
    await persist();
    sendJson(response, 200, { ok: true });
    return;
  }

  sendJson(response, 404, { error: "API-маршрут не найден" });
}

async function loadDatabase() {
  await mkdir(dirname(dataPath), { recursive: true });
  if (!existsSync(dataPath)) {
    const initial = structuredClone(defaultData);
    await writeFile(dataPath, JSON.stringify(initial, null, 2), "utf8");
    return initial;
  }
  try {
    const parsed = JSON.parse(await readFile(dataPath, "utf8"));
    parsed.users ||= [];
    parsed.opportunities ||= structuredClone(defaultData.opportunities);
    parsed.courses ||= structuredClone(defaultData.courses);
    parsed.messages ||= structuredClone(defaultData.messages);
    return parsed;
  } catch (error) {
    throw new Error(`Не удалось прочитать data/db.json: ${error.message}`);
  }
}

async function persist() {
  const temporary = `${dataPath}.tmp`;
  await writeFile(temporary, JSON.stringify(db, null, 2), "utf8");
  await rename(temporary, dataPath);
}

async function ensureAdmin() {
  if (db.users.some((item) => item.role === "admin")) return;
  const email = normalizeEmail(process.env.ADMIN_EMAIL || "admin@mentoria.local");
  const password = process.env.ADMIN_PASSWORD || "ChangeMeMentoria2026!";
  db.users.push({
    id: id("adm"), name: "Mentoria Admin", email, passwordHash: await hashPassword(password), role: "admin",
    grade: "11", country: "Казахстан", interests: ["Поступление", "STEM"], goals: ["Развитие сообщества"],
    savedOpportunityIds: [], enrolledCourseIds: [], completedLessons: {}, createdAt: new Date().toISOString()
  });
  await persist();
}

async function serveStatic(pathname, response, headOnly = false) {
  if (pathname === "/favicon.ico") {
    response.writeHead(204, { "Cache-Control": "public, max-age=86400" });
    response.end();
    return;
  }
  const requested = pathname === "/" ? "/index.html" : pathname;
  const withExtension = extname(requested) ? requested : `${requested}.html`;
  const decoded = decodeURIComponent(withExtension);
  const filePath = resolve(join(publicRoot, decoded));
  const safeRoot = resolve(publicRoot) + sep;
  if (filePath !== resolve(publicRoot) && !filePath.startsWith(safeRoot)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  try {
    const file = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
      "Cache-Control": extname(filePath) === ".html" ? "no-cache" : "public, max-age=3600"
    });
    response.end(headOnly ? undefined : file);
  } catch {
    const fallback = await readFile(join(publicRoot, "404.html"));
    response.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
    response.end(headOnly ? undefined : fallback);
  }
}

function setSecurityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self' https://api.openai.com; form-action 'self'; base-uri 'self'; frame-ancestors 'none'");
}

function sendJson(response, status, data) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(data));
}

async function readJson(request) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > MAX_BODY) throw Object.assign(new Error("Payload too large"), { status: 413, publicMessage: "Слишком большой запрос" });
  }
  try { return JSON.parse(raw || "{}"); }
  catch { throw badRequest("Некорректный JSON"); }
}

function currentUser(request) {
  const token = cookieMap(request).mh_session;
  if (!token) return null;
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    if (session) sessions.delete(token);
    return null;
  }
  return db.users.find((item) => item.id === session.userId) || null;
}

function createSession(response, user) {
  const token = randomBytes(32).toString("base64url");
  sessions.set(token, { userId: user.id, expiresAt: Date.now() + SESSION_MS });
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  response.setHeader("Set-Cookie", `mh_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_MS / 1000)}${secure}`);
}

function cookieMap(request) {
  return Object.fromEntries(String(request.headers.cookie || "").split(";").map((item) => item.trim()).filter(Boolean).map((item) => {
    const index = item.indexOf("=");
    return index > -1 ? [item.slice(0, index), decodeURIComponent(item.slice(index + 1))] : [item, ""];
  }));
}

async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const derived = await scrypt(password, salt, 64);
  return `${salt}:${Buffer.from(derived).toString("hex")}`;
}

async function verifyPassword(password, stored) {
  try {
    const [salt, hash] = stored.split(":");
    const derived = Buffer.from(await scrypt(password, salt, 64));
    const expected = Buffer.from(hash, "hex");
    return expected.length === derived.length && timingSafeEqual(expected, derived);
  } catch { return false; }
}

function publicUser(user) {
  const { passwordHash, ...safe } = user;
  return safe;
}

function validatePassword(password) {
  if (password.length < 8) throw badRequest("Пароль должен содержать минимум 8 символов");
  if (!/[A-Za-zА-Яа-яЁё]/.test(password) || !/\d/.test(password)) throw badRequest("Добавьте в пароль букву и цифру");
}

function normalizeEmail(value) { return String(value || "").trim().toLowerCase(); }
function isEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 180; }
function clean(value, max = 200) { return String(value || "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max); }
function cleanArray(value, maxItems, maxLength) { return Array.isArray(value) ? [...new Set(value.map((item) => clean(item, maxLength)).filter(Boolean))].slice(0, maxItems) : []; }
function id(prefix) { return `${prefix}_${Date.now().toString(36)}_${randomBytes(5).toString("hex")}`; }
function slug(value) { return clean(value, 100).toLowerCase().replace(/[^a-zа-яё0-9]+/gi, "-").replace(/^-|-$/g, "") || id("item"); }

function requireUser(user) { if (!user) throw unauthorized("Войдите в аккаунт, чтобы продолжить"); }
function requireAdmin(user) { requireUser(user); if (user.role !== "admin") throw forbidden("Нужны права администратора"); }
function findOpportunity(itemId) { const item = db.opportunities.find((entry) => entry.id === itemId); if (!item) throw notFound("Возможность не найдена"); return item; }
function findCourse(itemId) { const item = db.courses.find((entry) => entry.id === itemId); if (!item) throw notFound("Курс не найден"); return item; }

function filterOpportunities(params) {
  const search = clean(params.get("q"), 100).toLowerCase();
  const direction = clean(params.get("direction"), 60);
  const category = clean(params.get("category"), 60);
  const grade = clean(params.get("grade"), 4);
  const status = clean(params.get("status"), 20);
  return db.opportunities.filter((item) => {
    const haystack = `${item.title} ${item.organizer} ${item.direction} ${item.category} ${item.description}`.toLowerCase();
    const isOpen = new Date(item.deadline) > new Date();
    return (!search || haystack.includes(search)) && (!direction || item.direction === direction) && (!category || item.category === category) && (!grade || item.grades.includes(grade)) && (!status || status === (isOpen ? "open" : "closed"));
  }).sort((a, b) => new Date(a.deadline) - new Date(b.deadline));
}

function courseSummary(course) {
  const { lessons, ...summary } = course;
  return { ...summary, lessonsCount: lessons.length };
}

function recommendedOpportunities(user, limit = 4) {
  const interests = new Set([...(user.interests || []), ...(user.goals || [])].map((item) => item.toLowerCase()));
  return db.opportunities
    .filter((item) => new Date(item.deadline) > new Date() && item.grades.includes(user.grade))
    .map((item) => {
      const text = `${item.direction} ${item.category} ${item.description}`.toLowerCase();
      const score = [...interests].reduce((sum, interest) => sum + (text.includes(interest) ? 3 : 0), 0) + (item.featured ? 1 : 0);
      return { ...item, matchScore: score };
    })
    .sort((a, b) => b.matchScore - a.matchScore || new Date(a.deadline) - new Date(b.deadline))
    .slice(0, limit);
}

function normalizeOpportunity(body, itemId) {
  const title = clean(body.title, 140);
  const deadline = new Date(body.deadline);
  const url = String(body.url || "").trim();
  if (title.length < 4 || Number.isNaN(deadline.getTime())) throw badRequest("Укажите название и корректный дедлайн");
  if (!/^https:\/\//i.test(url)) throw badRequest("Ссылка должна начинаться с https://");
  return {
    id: itemId, title, organizer: clean(body.organizer, 100), category: clean(body.category, 60), direction: clean(body.direction, 60),
    format: clean(body.format || "Онлайн", 30), grades: cleanArray(body.grades, 4, 2), ages: clean(body.ages, 80), deadline: deadline.toISOString(),
    location: clean(body.location || "Международный", 80), fee: clean(body.fee || "Проверить на сайте", 80), language: clean(body.language, 60),
    prize: clean(body.prize, 200), description: clean(body.description, 700), requirements: cleanArray(body.requirements, 10, 180), steps: cleanArray(body.steps, 10, 180),
    url, verifiedAt: new Date().toISOString().slice(0, 10), featured: Boolean(body.featured)
  };
}

function assertSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return;
  const expected = `http://${request.headers.host}`;
  const forwarded = request.headers["x-forwarded-proto"] ? `${request.headers["x-forwarded-proto"]}://${request.headers.host}` : expected;
  if (origin !== expected && origin !== forwarded) throw forbidden("Запрос с другого источника отклонён");
}

function attemptKey(request) { return `${request.socket.remoteAddress || "unknown"}:${normalizeEmail(request.headers["x-login-email"] || "")}`; }
function enforceLoginRate(request) {
  const entry = loginAttempts.get(attemptKey(request));
  if (entry && entry.count >= 8 && Date.now() - entry.firstAt < 15 * 60_000) throw tooMany("Слишком много попыток. Повторите через 15 минут");
}
function recordFailedLogin(request) {
  const key = attemptKey(request); const entry = loginAttempts.get(key);
  loginAttempts.set(key, entry && Date.now() - entry.firstAt < 15 * 60_000 ? { ...entry, count: entry.count + 1 } : { count: 1, firstAt: Date.now() });
}
function clearFailedLogins(request) { loginAttempts.delete(attemptKey(request)); }

function demoMentorAnswer(user, message) {
  const recs = recommendedOpportunities(user, 2);
  const firstCourse = db.courses.find((course) => course.direction.toLowerCase().includes((user.interests[0] || "").toLowerCase())) || db.courses[0];
  return {
    mode: "smart-demo",
    text: `Начнём с конкретики, ${user.name}. По профилю ${user.grade} класса я бы поставил в фокус «${recs[0]?.title || "ближайшую возможность"}».\n\nПлан на 7 дней:\n1. Сегодня откройте правила и выпишите 3 требования.\n2. Завтра сформулируйте идею работы или решения.\n3. Выделите два блока по 45 минут на черновик.\n4. Добавьте курс «${firstCourse.title}» и завершите первый урок.\n5. За 48 часов до личного дедлайна проведите финальную проверку.\n\nВаш вопрос: «${message}». Если уточните, сколько часов в неделю у вас есть, я соберу более точный график.`
  };
}

async function openAiAnswer(user, message) {
  const recs = recommendedOpportunities(user, 4).map((item) => `${item.title} — ${item.deadline}`).join("; ");
  const input = [
    "Ты — доброжелательный образовательный наставник Mentoria Hub для учеников 8–11 классов.",
    "Отвечай по-русски, конкретно и безопасно. Не обещай поступление и не придумывай дедлайны.",
    `Профиль: ${user.name}, ${user.grade} класс, интересы: ${user.interests.join(", ") || "не указаны"}, цели: ${user.goals.join(", ") || "не указаны"}.`,
    `Проверенные возможности платформы: ${recs}.`,
    `Вопрос: ${message}`
  ].join("\n");
  const result = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: process.env.OPENAI_MODEL || "gpt-4.1-mini", input, max_output_tokens: 600 })
  });
  if (!result.ok) throw Object.assign(new Error(await result.text()), { status: 502, publicMessage: "AI-наставник временно недоступен" });
  const data = await result.json();
  const text = data.output_text || (data.output || []).flatMap((item) => item.content || []).filter((item) => item.type === "output_text").map((item) => item.text).join("\n");
  return { mode: "openai", model: process.env.OPENAI_MODEL || "gpt-4.1-mini", text };
}

function httpError(status, message) { return Object.assign(new Error(message), { status, publicMessage: message }); }
const badRequest = (message) => httpError(400, message);
const unauthorized = (message) => httpError(401, message);
const forbidden = (message) => httpError(403, message);
const notFound = (message) => httpError(404, message);
const conflict = (message) => httpError(409, message);
const tooMany = (message) => httpError(429, message);
