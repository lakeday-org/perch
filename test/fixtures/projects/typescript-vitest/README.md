# urlkit

Parse, build and resolve URLs and query strings. Nested keys, four array formats, and path templates, with no dependencies.

```ts
import { parse, stringify, Url, PathTemplate } from 'urlkit';

parse('user[name]=ada&tag[]=x&tag[]=y');
// { user: { name: 'ada' }, tag: ['x', 'y'] }

stringify({ q: 'a&b', page: 2 }, { sort: true });
// 'page=2&q=a%26b'

new Url('../teams', 'https://api.example.com/v1/users/42').toString();
// 'https://api.example.com/v1/teams'

new PathTemplate('/users/{id}').match('/users/42');
// { id: '42' }
```

## Array formats

| Format     | Written as            |
| ---------- | --------------------- |
| `brackets` | `a[]=1&a[]=2`         |
| `indices`  | `a[0]=1&a[1]=2`       |
| `comma`    | `a=1,2`               |
| `repeat`   | `a=1&a=2`             |

## Development

```sh
npm test          # vitest run
npm run coverage  # with v8 coverage
```
