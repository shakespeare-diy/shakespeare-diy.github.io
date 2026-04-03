import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ExternalLink, User } from 'lucide-react';
import type { AppSubmission } from '@/hooks/useAppSubmissions';
import { useAuthor } from '@/hooks/useAuthor';
import { nip19 } from 'nostr-tools';

interface AppShowcaseCardProps {
  app: AppSubmission;
}

export function AppShowcaseCard({ app }: AppShowcaseCardProps) {
  const [imageError, setImageError] = useState(false);

  const { data: authorData } = useAuthor(app.pubkey);

  const authorNpub = nip19.npubEncode(app.pubkey);

  return (
    <Card className="group hover:shadow-lg transition-all duration-300 hover:border-primary/20 h-full flex flex-col">
      {/* App Icon / Header */}
      <div className="relative">
        <a
          href={app.websiteUrl || undefined}
          target="_blank"
          rel="noopener noreferrer"
          className="block aspect-video bg-gradient-to-br from-muted/50 to-muted rounded-t-lg overflow-hidden cursor-pointer"
        >
          {app.appIconUrl && !imageError ? (
            <img
              src={app.appIconUrl}
              alt={`${app.appName} icon`}
              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
              onError={() => setImageError(true)}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-muted-foreground">
              <div className="text-center">
                <div className="w-16 h-16 mx-auto mb-2 bg-muted rounded-lg flex items-center justify-center">
                  <ExternalLink className="w-8 h-8" />
                </div>
                <p className="text-sm">No preview</p>
              </div>
            </div>
          )}
        </a>
      </div>

      <CardContent className="p-6 flex flex-col flex-1">
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-3">
            <div>
              <h3 className="text-xl font-semibold text-foreground mb-1" title={app.appName}>
                {app.appName.length > 50 ? `${app.appName.slice(0, 50)}...` : app.appName}
              </h3>
            </div>
          </div>
        </div>

        {app.description && (
          <p className="text-muted-foreground mb-3 line-clamp-3">{app.description}</p>
        )}

        {/* Author Information */}
        <div className="flex items-center gap-2 mb-4">
          <div className="w-6 h-6 rounded-full overflow-hidden bg-muted flex-shrink-0">
            {authorData?.metadata?.picture ? (
              <img
                src={authorData.metadata.picture}
                alt={`${authorData.metadata.name || 'Author'} avatar`}
                className="w-full h-full object-cover"
                onError={(e) => {
                  const target = e.target as HTMLImageElement;
                  target.style.display = 'none';
                  target.parentElement!.innerHTML = '<div class="w-full h-full flex items-center justify-center"><svg class="w-3 h-3 text-gray-400" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clip-rule="evenodd"></path></svg></div>';
                }}
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                <User className="w-3 h-3 text-muted-foreground" />
              </div>
            )}
          </div>
          <span className="text-sm text-muted-foreground">
            by{' '}
            <a
              href={`https://ditto.pub/${authorNpub}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:text-primary/80 transition-colors hover:underline"
            >
              {authorData?.metadata?.name || authorData?.metadata?.display_name || 'Anonymous'}
            </a>
          </span>
        </div>

        {/* Spacer to push action links to bottom */}
        <div className="flex-1"></div>

        {/* Action Links */}
        <div className="flex items-center gap-2 mt-auto">
          {app.repositoryUrl && (
            <Link
              to={`/clone?url=${encodeURIComponent(app.repositoryUrl)}`}
              className="flex-1"
            >
              <img
                src="/badge.svg"
                alt="Edit with Shakespeare"
                className="h-6 hover:opacity-80 transition-opacity"
              />
            </Link>
          )}
          {app.websiteUrl && (
            <Button variant="outline" size="sm" asChild>
              <a
                href={app.websiteUrl}
                target="_blank"
                rel="noopener noreferrer"
                title="Visit app"
              >
                <ExternalLink className="w-4 h-4" />
              </a>
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
