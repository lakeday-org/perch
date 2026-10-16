import { parse, stringify, Url } from '../src';

const url = new Url('https://shop.example.com/search?q=boots&size[]=42&size[]=43');
const query = parse(url.search);
console.log(query); // { q: 'boots', size: ['42', '43'] }

const next = stringify({ ...query, page: 2 }, { sort: true });
console.log(`${url.origin}${url.pathname}?${next}`);
