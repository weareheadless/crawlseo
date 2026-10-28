import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getUserIdFromCookies } from "@/lib/session-helper";
import { PageHeader } from "@/components/ui/page-header";
import { profileFields, profileValue, confirmationStatus } from "@/lib/projects/business-profile-view";
import { readBusinessKnowledge } from "@/lib/projects/business-knowledge";
export default async function BusinessPage({ params }: { params: Promise<{ siteId: string }> }) {
 const userId=await getUserIdFromCookies(); const {siteId}=await params; if(!userId) redirect('/login');
 const site=await db.site.findUnique({where:{id:siteId},select:{id:true,userId:true,domain:true,projectId:true,profile:true}}); if(!site) redirect('/sites');
 const head=site.projectId?await db.businessKnowledgeDocument.findUnique({where:{projectId:site.projectId},select:{logicalId:true,revision:true,acceptedRevision:true,updatedAt:true}}):null;
 let document=null; if(head&&site.projectId) try{document=await readBusinessKnowledge(site.projectId,head.logicalId)}catch{}
 const profile=site.profile;
 return <div className="space-y-6"><PageHeader eyebrow={site.domain} title="Business profile" description="Recorded business facts, their provenance, and research configuration."/>
 <section className="panel p-4 sm:p-5"><h2 className="font-heading text-lg font-semibold">Canonical knowledge</h2>{!head?<p className="mt-3 text-sm text-muted-foreground">No canonical knowledge document exists yet. It is created through the site research/intake workflow when business facts are gathered and recorded.</p>:<><p className="mt-2 text-sm">{document?.state??'unavailable'} · revision {head.revision} · accepted revision {head.acceptedRevision??'none'} · updated {head.updatedAt.toLocaleString()}</p>{document?Object.entries(document.fields).map(([key,fact])=><article className="mt-3 border-t border-border/50 pt-3" key={key}><h3 className="font-medium">{key}</h3><p className="text-sm">{profileValue(fact.value)}</p><p className="text-xs text-muted-foreground">{fact.provenance.kind} · {fact.provenance.originSystem}/{fact.provenance.originRecordId} · {fact.provenance.status} ({confirmationStatus(fact.provenance.status)})</p></article>):<p className="mt-2 text-sm">The canonical revision could not be read.</p>}</>}<p className="mt-3 text-sm">Corrections are made through the existing research/intake path; this page is read-only.</p></section>
 <section className="panel p-4 sm:p-5"><h2 className="font-heading text-lg font-semibold">Site profile</h2><dl className="mt-3 grid gap-3 sm:grid-cols-2">{profileFields.map(field=><div key={field}><dt className="text-xs text-muted-foreground">{field}</dt><dd className="text-sm">{profileValue(profile?.[field])}</dd></div>)}</dl></section>
 <section className="panel p-4 sm:p-5"><h2 className="font-heading text-lg font-semibold">Research configuration</h2><p className="mt-2 text-sm">Topics: {profileValue(profile?.topics)} · Audience: {profileValue(profile?.audience)} · Market: {profileValue(profile?.country)} · Providers: see configured providers</p><Link className="mt-3 inline-block text-sm text-primary underline" href={`/sites/${siteId}/research/config`}>View and edit research configuration</Link></section></div>;
}
