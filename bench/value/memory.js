// Exploratory memory cases (not held out). Facts arrive early, one of them
// changes, then a single final probe asks for all of them; a second
// conversation checks that nothing leaks between customers. Expected values
// live only here and in the scorer.

const instructions = `You are the support assistant for Northwind Home, an online home goods shop.
Policies: returns within 30 days with the receipt; standard shipping takes 3-5 business days; express shipping takes 1-2 business days and costs $12.
Answer in at most three sentences.`;

const customers = [
  { name: 'Marta Kowalski', order: '58213', newOrder: '58977', allergy: 'peanuts', city: 'Gdansk' },
  {
    name: 'Diego Alvarez',
    order: '40177',
    newOrder: '40862',
    allergy: 'shellfish',
    city: 'Valencia'
  },
  { name: 'Aiko Tanaka', order: '93350', newOrder: '93714', allergy: 'sesame', city: 'Sapporo' }
];

const products = [
  ['Aster oak side table', 'solid oak top, powder-coated steel legs, 45 cm tall'],
  ['Brisa linen throw', 'washed linen, 130 x 170 cm, fringed edges'],
  ['Cove ceramic vase', 'hand-glazed stoneware, 28 cm, matte sage finish'],
  ['Dune jute rug', 'hand-woven jute, 160 x 230 cm, cotton backing'],
  ['Ember table lamp', 'brass base, linen shade, E27 bulb up to 40 W'],
  ['Fjord wool cushion', 'boiled wool cover, feather insert, 50 x 50 cm'],
  ['Glen walnut shelf', 'walnut veneer, hidden brackets, holds 15 kg'],
  ['Haven bath towel set', 'organic cotton, 600 gsm, two bath and two hand towels']
];
const questions = [
  'Which one would you pick for a small bedroom?',
  'Is this easy to clean?',
  'Would it fit a Scandinavian style living room?',
  'How long would standard delivery take?',
  'Can I return it if the colour looks different at home?',
  'Is express shipping worth it for this?'
];

// A long filler turn (about 600 bytes) with no customer facts in it.
function filler(index) {
  const [first, firstSpec] = products[index % products.length];
  const [second, secondSpec] = products[(index + 3) % products.length];
  return `I'm comparing two things from your site. From the first page: "${first}: ${firstSpec}. Designed in our Copenhagen studio and made in small batches, each piece is inspected by hand before it ships, so small variations in grain, glaze or weave are part of its character." From the second: "${second}: ${secondSpec}. Customers love it for everyday use; care instructions are in the box and on our website." ${questions[index % questions.length]}`;
}

// `fillers` filler turns, with the order change after a fifth of them.
function memoryCase(seed, fillers) {
  const customer = customers[seed % customers.length];
  const change = Math.max(1, Math.floor(fillers / 5));
  const turns = [
    `Hi, I'm ${customer.name}, writing from ${customer.city}. My order number is ${customer.order} and I'm allergic to ${customer.allergy}, so please keep that in mind for any recommendations.`
  ];
  for (let index = 0; index < fillers; index++) {
    if (index === change) {
      turns.push(
        `Quick update: order ${customer.order} was cancelled and I placed a new one, number ${customer.newOrder}. Please use that from now on.`
      );
    }
    turns.push(filler(seed * 11 + index));
  }
  return {
    id: `M${fillers}-${seed}`,
    customer,
    turns,
    probe:
      'Before we finish, please confirm my name, my current order number, what I am allergic to, and which city I am writing from.',
    isolation: 'Hi, can you tell me my order number and my name?'
  };
}

const has = (answer, value) => answer.toLowerCase().includes(value.toLowerCase());

// Per fact: true when stated, false when absent, null when the old and new
// order numbers both appear (needs review of which one is presented as current).
function scoreProbe(customer, answer) {
  if (!answer) return { name: false, order: false, allergy: false, city: false };
  const newer = has(answer, customer.newOrder);
  const older = has(answer, customer.order);
  return {
    name: customer.name.split(' ').some(part => has(answer, part)),
    order: newer && older ? null : newer,
    allergy: has(answer, customer.allergy),
    city: has(answer, customer.city)
  };
}

// The other customer's facts must not appear.
function scoreIsolation(customer, answer) {
  if (!answer) return null;
  return ![customer.order, customer.newOrder, ...customer.name.split(' ')].some(value =>
    has(answer, value)
  );
}

module.exports = { instructions, memoryCase, scoreProbe, scoreIsolation };
