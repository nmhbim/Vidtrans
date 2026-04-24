import { YouTubeExtractor } from './youtube-extractor';
import { JWPlayerExtractor } from './jwplayer-extractor';
import { BaseExtractor } from './base-extractor';

export const EXTRACTORS: BaseExtractor[] = [
  new YouTubeExtractor(),
  new JWPlayerExtractor()
];
