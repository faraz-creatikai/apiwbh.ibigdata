import prisma from "../config/prismaClient.js";

const toISODate = (val) => {
  if (!val) return null;

  // convert "2026-04-03 09:34:05"
  const iso = val.replace(" ", "T") + "Z";

  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
};

export const syncCallLogsInternal = async () => {
    const response = await fetch(
        `https://www.tabbly.io/dashboard/agents/endpoints/call-logs-v2?api_key=${process.env.TAPPLY_API_KEY}&organization_id=${process.env.TAPPLY_ORG_ID}&use_agent_id=${process.env.TAPPLY_CALL_AGENT_ID}`
    );

    const data = await response.json();
    if (!data?.data) return;


    //multiple dall log updation parallel with Promise.all and upsert to avoid duplicates
   /*  await Promise.all(
        data.data.map(async (log) => {
            const normalizedPhone = log.called_to?.slice(-10);

            const mappedData = {
                agentId: log.use_agent_id,
                organizationId: String(log.organization_id),
                calledTo: log.called_to,
                normalizedPhone,
                callDirection: log.call_direction,
                callStatus: log.call_status,
                callDuration: Number(log.call_duration) || 0,
                startTime: log.start_time ? new Date(log.start_time) : null,
                endTime: log.end_time ? new Date(log.end_time) : null,
                calledTime: log.created_at ? new Date(log.created_at) : null,
                recordingUrl: log.call_recording_url,
                transcript: log.transcript,
                summary: log.call_summary,
                sentiment: log.call_sentiment,
                totalCallCost: log.total_call_cost,
                telcoPricing: log.telco_pricing,
                agentCost: log.agent_cost,
                rawJson: log,
            };

            await prisma.callLog.upsert({
                where: {
                    participantIdentity: log.participant_identity,
                },
                update: mappedData,
                create: {
                    participantIdentity: log.participant_identity,
                    ...mappedData,
                },
            });
        })
    ); */

    //single log updation with upsert to avoid duplicates
     await Promise.all(
    data.data.map(async (log) => {
      const normalizedPhone = log.called_to?.slice(-10);
  
        const mappedData = {
  agentId: String(log.use_agent_id ?? ""),
  organizationId: String(log.organization_id ?? ""),
  calledTo: String(log.called_to ?? ""),
  normalizedPhone,

  callDirection: String(log.call_direction ?? ""),
  callStatus: String(log.call_status ?? ""),
  callDuration: String(log.call_duration ?? "0"),

  // ✅ FIXED
  startTime: toISODate(log.start_time),
  endTime: toISODate(log.end_time),
  calledTime: toISODate(log.created_at),

  recordingUrl: String(log.call_recording_url ?? ""),
  transcript: String(log.call_transcript ?? ""),
  summary: String(log.call_summary ?? ""),
  sentiment: String(log.call_sentiment ?? ""),

  totalCallCost: String(log.total_call_cost ?? ""),
  telcoPricing: String(log.telco_pricing ?? ""),
  agentCost: String(log.agent_cost ?? ""),

  rawJson: log,
};
  
      await prisma.callLog.updateMany({
        where: {
          participantIdentity: log.participant_identity,
        },
        data: mappedData,
      });
    })
  );
};