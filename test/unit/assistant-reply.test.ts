import { describe, expect, test } from "bun:test";
import { isAssistantReply } from "../../src/domain/hallucination.ts";

// TC-2119: a region is dropped only when the WHOLE text is assistant boilerplate.
const REPORTED = "Thank you for your question. However, I'm not sure what you're referring to. Could you please provide more context or clarify your request? This will help me give you a more accurate and helpful response.";

describe("isAssistantReply", () => {
  test.each([
    ["the reported reply", REPORTED],
    ["curly apostrophes and odd spacing", "Thank you for your question.  However, I’m not sure what you’re referring to."],
    ["as an AI", "As an AI language model."],
    ["I'm sorry, but", "I'm sorry, but I can't assist with that."],
    ["how can I help", "Hello! How can I help you today?"],
    ["I cannot transcribe", "I cannot transcribe this audio."],
    ["request for context", "Could you please provide more context?"],
  ])("drops %s", (_name, text) => expect(isAssistantReply(text)).toBe(true));

  test.each([
    ["a phrase inside a long real sentence", "Thank you for your question, the quarterly numbers show revenue up twelve percent across all regions and we expect that to continue."],
    ["a phrase followed by real content", "Thank you for your question. The answer is that we shipped on Friday."],
    ["an apology that is not an assistant refusal", "I'm sorry, but I can't make it on Thursday."],
    ["as an AI in real speech", "As an AI researcher I think the model is fine."],
    ["a stock caption (handled elsewhere)", "Thank you."],
    ["a question about real content", "How can I help with the budget? Let me look at the numbers."],
    ["the reported reply buried in a long recording", `${REPORTED} ${"The meeting then moved on to the roadmap and staffing. ".repeat(10)}`],
    ["empty", "   "],
  ])("keeps %s", (_name, text) => expect(isAssistantReply(text)).toBe(false));
});
