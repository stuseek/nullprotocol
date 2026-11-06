// Create photo-reader in the dashboard and choose a model marked Photos.
// NULLPROTOCOL_KEY stays on your backend. PHOTO_URL can be a reachable signed URL.
import { NullProtocol } from 'nullprotocol';

const agent = await NullProtocol.load({
  key: process.env.NULLPROTOCOL_KEY,
  agentId: process.env.AGENT_ID || 'photo-reader'
});
const result = await agent.extract(
  'Identify the landmark in the photo.',
  { landmark: 'string' },
  {
    images: [
      process.env.PHOTO_URL ||
        'https://images.unsplash.com/photo-1502602898657-3e91760cbb34?w=800&q=80'
    ]
  }
);
if (!result.success) {
  console.error(result.errorCode, result.error);
  process.exitCode = 1;
} else {
  console.log(result.data);
  console.log(result.usage);
}
if (result.historyError) {
  console.error('History was not saved:', result.historyError);
  process.exitCode = 1;
}
