export const wordfreqCases = [
  { name: 'Top three', input: { argv: ['--top', '3'], stdin: { text: 'a b a c a b' } } },
  { name: 'Default top', input: { stdin: { text: 'one two two three three three four four four four five five five five five six six six six six six' } } },
  { name: 'Top one', input: { argv: ['--top', '1'], stdin: { text: 'x y y' } } },
  { name: 'Empty input', input: {} },
  { name: 'Unknown flag', input: { argv: ['--nope'] } },
  { name: 'Zero limit', input: { argv: ['--top', '0'] } },
  { name: 'Stopwords file', input: { argv: ['--top', '5'], stdin: { text: 'the cat and the dog of the bird' }, files: [{ path: 'stopwords.txt', text: 'the\nand\nof\n' }] } },
  { name: 'Case and punctuation', input: { stdin: { text: 'Hello, HELLO! hello... World; world?' } } },
  { name: 'Alphabetical tie', input: { argv: ['--top', '4'], stdin: { text: 'pear apple fig kiwi' } } },
  { name: 'Non-ASCII input', input: { stdin: { text: 'café café naïve' } } },
];
