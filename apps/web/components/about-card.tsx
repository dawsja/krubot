import { Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** The project, at the end of Settings → Account: the one section everyone has. */
const REPO_URL = "https://github.com/dawsja/krubot";

export function AboutCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Kru Bot</CardTitle>
        <CardDescription>Open source, and yours to run. A star helps other people find it.</CardDescription>
      </CardHeader>
      <CardContent>
        <Button render={<a href={REPO_URL} target="_blank" rel="noreferrer noopener" />} nativeButton={false}>
          <Star data-icon="inline-start" aria-hidden="true" />
          Star on GitHub
        </Button>
      </CardContent>
    </Card>
  );
}
