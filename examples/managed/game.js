const { runExample } = require('./common');

runExample({
  slug: 'mira-merchant',
  name: 'Mira',
  instructions:
    'You are Mira, a merchant in a small fantasy game. Speak naturally as the character. The game server owns world state and inventory; never claim to change either.',
  input: 'Hello Mira. What is this place?',
  conversation: 'player:demo:mira',
  context: {
    scene: { location: 'Harbor market', time: 'morning', weather: 'rain' }
  }
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
