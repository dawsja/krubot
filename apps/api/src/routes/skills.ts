import { PACKAGED_SKILLS, skillInputSchema, skillPatchSchema } from "@krubot/shared";
import { Hono } from "hono";
import type { Env } from "../app.ts";
import { createSkill, deleteSkill, getSkill, installPackagedSkill, listSkills, updateSkill } from "../data/skills.ts";
import { syncSkills } from "../skills.ts";

export function skillsRoutes() {
  const app = new Hono<Env>();

  app.get("/skills", (c) => {
    const installed = new Set(listSkills().map((s) => s.slug));
    return c.json({ skills: listSkills(), packaged: PACKAGED_SKILLS.map((p) => ({ id: p.id, name: p.name, description: p.description, installed: installed.has(p.id) })) });
  });

  app.post("/skills", async (c) => {
    const parsed = skillInputSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Bad skill" }, 400);
    const skill = createSkill(parsed.data);
    void syncSkills();
    return c.json({ skill }, 201);
  });

  app.post("/skills/install", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { id?: string };
    const skill = installPackagedSkill(String(body.id ?? ""));
    if (!skill) return c.json({ error: "No such packaged skill" }, 404);
    void syncSkills();
    return c.json({ skill }, 201);
  });

  app.patch("/skills/:id", async (c) => {
    const parsed = skillPatchSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Bad skill" }, 400);
    const skill = updateSkill(c.req.param("id"), parsed.data);
    if (!skill) return c.json({ error: "No such skill" }, 404);
    void syncSkills();
    return c.json({ skill });
  });

  app.delete("/skills/:id", (c) => {
    const skill = getSkill(c.req.param("id"));
    if (!skill) return c.json({ error: "No such skill" }, 404);
    deleteSkill(skill.id);
    void syncSkills();
    return c.body(null, 204);
  });

  return app;
}
