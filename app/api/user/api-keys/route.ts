import { getUserIdFromCookies } from "@/lib/session-helper";
import { db } from "@/lib/db";
import { encrypt } from "@/lib/encryption";

export async function GET() {
  try {
    const userId = await getUserIdFromCookies();
    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const [keys, platformDataForSeo] = await Promise.all([
      // Workspace-wide: the key belongs to the workspace, whichever account
      // stored it.
      db.apiKey.findMany({
        select: { provider: true, createdAt: true, updatedAt: true },
        orderBy: { updatedAt: "desc" },
      }),
      db.providerCredential.findUnique({
        where: { provider_label: { provider: "dataforseo", label: "crawlseo-platform" } },
        select: { status: true, updatedAt: true },
      }),
    ]);

    const providers: Record<string, { connected: boolean; managed?: boolean; updatedAt?: string }> = {
      dataforseo: { connected: false },
    };

    for (const key of keys) {
      const current = providers[key.provider];
      // Rows are newest first; a provider with an older duplicate keeps the
      // most recent credential in the status the settings form shows.
      if (current?.connected && current.updatedAt) continue;
      providers[key.provider] = {
        connected: true,
        updatedAt: key.updatedAt.toISOString(),
      };
    }
    if (platformDataForSeo?.status === "ACTIVE") {
      providers.dataforseo = {
        connected: true,
        managed: true,
        updatedAt: platformDataForSeo.updatedAt.toISOString(),
      };
    }

    return Response.json(providers);
  } catch (error) {
    console.error("API keys GET error:", error);
    return Response.json({ error: "Failed to load API keys" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const userId = await getUserIdFromCookies();
    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json()) as {
      provider?: string;
      login?: string;
      password?: string;
    };

    if (!body.provider || !body.login || !body.password) {
      return Response.json(
        { error: "Missing required fields: provider, login, password" },
        { status: 400 }
      );
    }

    if (body.provider !== "dataforseo") {
      return Response.json({ error: "Unsupported provider" }, { status: 400 });
    }

    // The workspace keeps one key per provider: updating the stored credential
    // replaces it instead of adding a second row under the signed-in account.
    const existing = await db.apiKey.findFirst({
      where: { provider: body.provider },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    });
    const saved = existing
      ? await db.apiKey.update({
          where: { id: existing.id },
          data: {
            encryptedLogin: encrypt(body.login),
            encryptedPassword: encrypt(body.password),
          },
        })
      : await db.apiKey.create({
          data: {
            userId,
            provider: body.provider,
            encryptedLogin: encrypt(body.login),
            encryptedPassword: encrypt(body.password),
          },
        });

    // Keep project ownership explicit when a user adds the provider key after
    // a project was provisioned. The research worker never resolves a project
    // credential indirectly at execution time.
    const projects = await db.project.findMany({
      // Every project with a site is in this workspace, so the key is granted
      // to all of them regardless of which account created the site.
      where: { sites: { some: {} } },
      select: { id: true },
    });
    const managedGrants = await db.projectApiKeyGrant.findMany({
      where: {
        projectId: { in: projects.map((project) => project.id) },
        provider: body.provider,
        status: "ACTIVE",
        providerCredentialId: { not: null },
        providerCredential: { is: { status: "ACTIVE" } },
      },
      select: { projectId: true },
    });
    const platformManagedProjectIds = new Set(
      managedGrants.map((grant) => grant.projectId)
    );
    await db.$transaction(
      projects
        .filter((project) => !platformManagedProjectIds.has(project.id))
        .map((project) =>
          db.projectApiKeyGrant.upsert({
            where: { projectId_provider: { projectId: project.id, provider: body.provider! } },
            create: {
              projectId: project.id,
              apiKeyId: saved.id,
              provider: body.provider!,
              status: "ACTIVE",
            },
            update: {
              apiKeyId: saved.id,
              providerCredentialId: null,
              status: "ACTIVE",
            },
          })
        )
    );

    return Response.json(
      { provider: saved.provider, connected: true },
      { status: 201 }
    );
  } catch (error) {
    console.error("API keys POST error:", error);
    return Response.json({ error: "Failed to save API key" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const userId = await getUserIdFromCookies();
    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json()) as { provider?: string };
    if (!body.provider) {
      return Response.json({ error: "Missing provider" }, { status: 400 });
    }

    await db.apiKey.deleteMany({ where: { provider: body.provider } });

    return Response.json({ success: true });
  } catch (error) {
    console.error("API keys DELETE error:", error);
    return Response.json({ error: "Failed to delete API key" }, { status: 500 });
  }
}
