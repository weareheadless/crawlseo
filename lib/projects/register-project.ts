import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { createServiceCredential } from "@/lib/auth/service-credentials";

export type RegisterProjectInput = {
  schemaVersion: "business-knowledge/1";
  kind: "project_registration";
  externalOrganizationId: string;
  workspaceName: string;
  externalProjectId: string;
  displayName: string;
  domain?: string | null;
  origin: { system: string; externalId: string };
  idempotencyKey: string;
  requestedCredentialScope: { audience: "business-knowledge"; requestedPermissions: string[] };
};

export type RegisteredProjectIdentity = {
  schemaVersion: "business-knowledge/1";
  kind: "project_registration_result";
  externalOrganizationId: string;
  externalProjectId: string;
  origin: { system: string; externalId: string };
  workspaceId: string;
  workspaceName: string;
  projectId: string;
  credentialScope: {
    audience: "business-knowledge";
    workspaceId: string;
    projectId: string;
    externalOrganizationId: string;
    permissions: string[];
  };
};

export type RegisteredProjectResult = { identity: RegisteredProjectIdentity; credentialToken: string | null };

export class ProjectRegistrationError extends Error {
  constructor(readonly code: "INVALID_REQUEST" | "FORBIDDEN" | "IDEMPOTENCY_CONFLICT" | "ORIGIN_CONFLICT", message: string) {
    super(message);
    this.name = "ProjectRegistrationError";
  }
}

const REGISTRATION_OPERATION = "register_project_v1";
const MAX_KEY_LENGTH = 240;
const REQUESTABLE_PERMISSIONS = new Set(["project:read", "document:read", "document:write"]);
const READ_PERMISSIONS = new Set(["project:read", "document:read"]);
const HELLOADA_INTAKE_PERMISSIONS = new Set(["project:read", "document:read", "document:write"]);

function normalizeDomain(value: string | null | undefined): string | null {
  if (value == null) return null;
  const domain = value.trim().toLowerCase().replace(/\.$/, "");
  const label = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
  if (domain.length > 253 || !new RegExp(`^${label}(?:\\.${label})*$`).test(domain)) {
    throw new ProjectRegistrationError("INVALID_REQUEST", "Invalid public domain metadata");
  }
  return domain;
}

function normalizeInput(input: RegisterProjectInput) {
  const externalOrganizationId = input.externalOrganizationId.trim();
  const workspaceName = input.workspaceName.trim() || externalOrganizationId;
  const projectName = input.displayName.trim();
  const system = input.origin.system.trim();
  const externalId = input.origin.externalId.trim();
  const externalProjectId = input.externalProjectId.trim();
  const domain = normalizeDomain(input.domain);
  const idempotencyKey = input.idempotencyKey.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(externalOrganizationId) || !projectName || projectName.length > 500 ||
      !workspaceName || workspaceName.length > 500 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(system) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(externalId) || idempotencyKey.length < 8 || idempotencyKey.length > MAX_KEY_LENGTH ||
      externalProjectId.length > 120 || externalProjectId !== `${system}:${externalId}` ||
      input.requestedCredentialScope.audience !== "business-knowledge") {
    throw new ProjectRegistrationError("INVALID_REQUEST", "Invalid project registration fields");
  }
  const requestedPermissions = [...new Set(input.requestedCredentialScope.requestedPermissions.map((value) => value.trim()).filter(Boolean))].sort();
  if (requestedPermissions.length < 1 || requestedPermissions.length > 3 ||
      requestedPermissions.some((permission) => !REQUESTABLE_PERMISSIONS.has(permission)) ||
      input.requestedCredentialScope.requestedPermissions.length !== requestedPermissions.length) {
    throw new ProjectRegistrationError("INVALID_REQUEST", "Invalid requested permissions");
  }
  const requestHash = createHash("sha256").update(JSON.stringify({
    externalOrganizationId,
    workspaceName,
    projectName,
    origin: { system, externalId },
    domain,
    requestedPermissions,
  })).digest("hex");
  const grantablePermissions = system === "helloada" ? HELLOADA_INTAKE_PERMISSIONS : READ_PERMISSIONS;
  return { externalOrganizationId, workspaceName, projectName, system, externalId, externalProjectId,
    domain, requestedPermissions, permissions: requestedPermissions.filter((permission) => grantablePermissions.has(permission)),
    idempotencyKey, requestHash };
}

function asIdentity(value: Prisma.JsonValue): RegisteredProjectIdentity {
  return value as unknown as RegisteredProjectIdentity;
}

/** Create one project identity without creating a Site, Google connection, or provider job. */
export async function registerProject(input: RegisterProjectInput): Promise<RegisteredProjectResult> {
  const normalized = normalizeInput(input);
  const receiptWhere = { externalOrganizationId_operation_idempotencyKey: {
    externalOrganizationId: normalized.externalOrganizationId,
    operation: REGISTRATION_OPERATION,
    idempotencyKey: normalized.idempotencyKey,
  } };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await db.$transaction(async (tx) => {
        const prior = await tx.projectRegistrationReceipt.findUnique({ where: receiptWhere });
        if (prior) {
          if (prior.requestHash !== normalized.requestHash) {
            throw new ProjectRegistrationError("IDEMPOTENCY_CONFLICT", "Idempotency key was reused for a different registration");
          }
          return { identity: asIdentity(prior.result), credentialToken: null };
        }

        const workspace = await tx.workspace.upsert({
          where: { externalOrganizationId: normalized.externalOrganizationId },
          create: { externalOrganizationId: normalized.externalOrganizationId, name: normalized.workspaceName },
          update: { name: normalized.workspaceName },
          select: { id: true },
        });
        const existingProject = await tx.project.findUnique({
          where: { workspaceId_externalProjectId: { workspaceId: workspace.id, externalProjectId: normalized.externalProjectId } },
          select: { id: true, name: true, status: true, registrationRequestHash: true },
        });
        if (existingProject && (existingProject.name !== normalized.projectName || existingProject.status !== "ACTIVE")) {
          throw new ProjectRegistrationError("ORIGIN_CONFLICT", "Project origin is already registered with conflicting data");
        }
        if (existingProject?.registrationRequestHash && existingProject.registrationRequestHash !== normalized.requestHash) {
          throw new ProjectRegistrationError("ORIGIN_CONFLICT", "Project origin is already registered with conflicting data");
        }
        const shouldIssueCredential = !existingProject?.registrationRequestHash;
        const project = existingProject
          ? await tx.project.update({
            where: { id: existingProject.id },
            data: { registrationRequestHash: normalized.requestHash, registrationDomain: normalized.domain },
            select: { id: true },
          })
          : await tx.project.create({
            data: { workspaceId: workspace.id, externalProjectId: normalized.externalProjectId, name: normalized.projectName,
              registrationRequestHash: normalized.requestHash, registrationDomain: normalized.domain },
            select: { id: true },
          });
        const result: RegisteredProjectIdentity = {
          schemaVersion: "business-knowledge/1",
          kind: "project_registration_result",
          externalOrganizationId: normalized.externalOrganizationId,
          externalProjectId: normalized.externalProjectId,
          origin: { system: normalized.system, externalId: normalized.externalId },
          workspaceId: workspace.id,
          workspaceName: normalized.workspaceName,
          projectId: project.id,
          credentialScope: {
            audience: "business-knowledge",
            workspaceId: workspace.id,
            projectId: project.id,
            externalOrganizationId: normalized.externalOrganizationId,
            permissions: normalized.permissions,
          },
        };
        if (normalized.permissions.length === 0) {
          throw new ProjectRegistrationError("FORBIDDEN", "No supported project permissions were requested");
        }
        const credential = shouldIssueCredential ? await createServiceCredential(project.id, normalized.permissions, {
          idempotencyKey: `business-knowledge:${createHash("sha256").update(project.id).digest("hex")}`,
          principalName: "business-knowledge",
          requestHash: normalized.requestHash,
          revokeExisting: false,
          transaction: tx,
        }) : null;
        await tx.projectRegistrationReceipt.create({ data: {
          externalOrganizationId: normalized.externalOrganizationId,
          operation: REGISTRATION_OPERATION,
          idempotencyKey: normalized.idempotencyKey,
          requestHash: normalized.requestHash,
          result: result as unknown as Prisma.InputJsonValue,
        } });
        return { identity: result, credentialToken: credential?.token ?? null };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof ProjectRegistrationError) throw error;
      const code = (error as { code?: string }).code;
      if (code !== "P2002" && code !== "P2034") throw error;
      const receipt = await db.projectRegistrationReceipt.findUnique({ where: receiptWhere });
      if (receipt) {
        if (receipt.requestHash !== normalized.requestHash) {
          throw new ProjectRegistrationError("IDEMPOTENCY_CONFLICT", "Idempotency key was reused for a different registration");
        }
        return { identity: asIdentity(receipt.result), credentialToken: null };
      }
      const workspace = await db.workspace.findUnique({
        where: { externalOrganizationId: normalized.externalOrganizationId },
        select: { id: true },
      });
      const project = workspace ? await db.project.findUnique({
        where: { workspaceId_externalProjectId: { workspaceId: workspace.id, externalProjectId: normalized.externalProjectId } },
        select: { name: true },
      }) : null;
      if (project && project.name !== normalized.projectName) {
        throw new ProjectRegistrationError("ORIGIN_CONFLICT", "Project origin is already registered with conflicting data");
      }
      if (attempt === 2) throw error;
    }
  }
  throw new Error("Project registration retry exhausted");
}
