// JSX knows <slidra-player> (lib/element/slidra-player.js) as an intrinsic element.
import "react";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "slidra-player": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string;
        slide?: string;
        controls?: string;
        "allow-remote"?: string;
        "runtime-src"?: string;
        class?: string;
      };
    }
  }
}
