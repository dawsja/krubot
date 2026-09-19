import { Heart, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** The project, at the end of Settings → Account: the one section everyone has. */
const REPO_URL = "https://github.com/dawsja/krubot";
const SPONSOR_URL = "https://github.com/sponsors/dawsja";

export function AboutCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Kru Bot</CardTitle>
        <CardDescription>Open source, and yours to run. A star helps other people find it; sponsoring pays for the work that keeps it going.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <Button variant="outline" render={<a href={REPO_URL} target="_blank" rel="noreferrer noopener" />} nativeButton={false}>
          <Star data-icon="inline-start" aria-hidden="true" />
          Star on GitHub
        </Button>
        <Button render={<a href={SPONSOR_URL} target="_blank" rel="noreferrer noopener" />} nativeButton={false}>
          <Heart data-icon="inline-start" aria-hidden="true" />
          Sponsor
        </Button>
      </CardContent>
    </Card>
  );
}
