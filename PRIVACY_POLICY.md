# Privacy Policy for Librarian Bot

Your privacy is extremely important to us. This Privacy Policy details how Librarian Bot ("the Bot") handles user data and inputs.

## 1. No Local Storage of Data
The Bot is designed to be completely stateless regarding your personal data. 
- **No Database**: The Bot does not utilize or maintain a local database to store message histories, user profiles, or channel interactions.
- **In-Memory Only**: Any data read from the Discord API (such as the recent message list for conversation context or channel descriptions) is processed entirely in-memory and discarded immediately after use.

## 2. Stateless LLM & Search Processing (No Caching)
- **No LLM Output Caching**: When you mention the Bot to ask a question, the prompt is sent directly to the local model. Neither the prompts nor the generated LLM responses are cached, logged, or saved to a database.
- **Local RAG Integration**: To answer questions, the Bot fetches the last few messages in the channel (up to 20 messages) and context from a local SearXNG search instance. This data is merged into a single prompt, sent to the LLM, and immediately deleted from RAM after the response is sent to Discord.

## 3. Host Server & Private Processing
- **Self-Hosted LLM**: The local Ollama instance runs in a barebones Docker container hosted on a private server with local NVIDIA GPU access. 
- **No Third-Party APIs**: None of your prompts, messages, search requests, or server metadata are sent to external cloud AI providers (like OpenAI or Anthropic). All processing is kept strictly local on our private infrastructure.

## 4. Discord API Access
The Bot only requests permissions necessary to perform its functions (such as managing campaign channels, deleting/pinning messages in campaign channels, and reacting to emojis). It will not read or scan messages outside of the specific campaign channels it is assigned to manage or when it is directly mentioned.

## 5. Contact
If you have any questions about this Privacy Policy, please contact the server administrator.
