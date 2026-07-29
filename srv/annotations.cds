/**
 * Annotation index.
 *
 * CAP auto-loads the `.cds` files sitting directly in `srv/`, but it does not
 * recurse into subfolders. The annotation files are kept in `srv/annotations/`
 * so the service definitions stay readable as API contracts, which means they
 * have to be pulled in explicitly from here or Fiori elements would receive
 * metadata with no UI annotations at all.
 */

using from './annotations/ai-annotations';
using from './annotations/analytics-annotations';
