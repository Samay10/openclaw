import { admitSessionTranscriptQuestionAnswer } from "../../config/sessions/session-transcript-read-fence.js";
import {
  createAgentQuestionAnswerAuthority,
  type PreparedQuestionAnswerAuthority,
} from "../harness/host-private-capabilities.js";

/** CLI prepare wires the same admit hook the gateway embedded runner receives. */
export function createCliQuestionAnswerAuthority(
  params: Parameters<typeof createAgentQuestionAnswerAuthority>[0],
): PreparedQuestionAnswerAuthority {
  return createAgentQuestionAnswerAuthority({
    ...params,
    admitTranscriptAnswer: admitSessionTranscriptQuestionAnswer,
  });
}
