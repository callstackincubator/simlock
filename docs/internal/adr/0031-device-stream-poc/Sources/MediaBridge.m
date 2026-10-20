#import "MediaBridge.h"
#import <dlfcn.h>
#import <objc/message.h>
@interface NSObject (AVCProbe)
- (id)initWithMode:(NSInteger)mode options:(NSDictionary*)options error:(NSError**)error;
- (id)offer;
- (BOOL)setAnswer:(NSData*)answer withError:(NSError**)error;
- (id)generateMediaStreamConfigurationWithError:(NSError**)error;
- (id)dictionary;
@end
#import <objc/runtime.h>
// LTRP was disabled during the artifact investigation. It did not fix the corruption;
// preserve that setting while changing the independent HEVC capability advertisement.
// No system framework is modified: these hooks affect only this demo process.
static IMP originalScreenFeatures;
static NSDictionary *screenDecoderFeatures(id self, SEL selector) {
 NSDictionary *original=((NSDictionary *(*)(id,SEL))originalScreenFeatures)(self,selector);
 NSMutableDictionary *features=[original mutableCopy];
 // Payload 100 is HEVC; preserve H.264 and every other negotiated setting.
 // DeviceHub advertises FLS;VRAE:0;SW:1;. The idevice receiver documents tearing
 // with that preset and uses this alternative for its standalone HEVC decoder:
 // https://docs.rs/idevice/latest/src/idevice/services/core_device/display_stream/negotiation.rs.html
 if(features[@100]) features[@100]=@"FLS;MS:-1;LF:-1;LTR;CABAC;POS:0;EOD:1;HTS:2;RR:3;AR:16/9,5/8;XR:16/9,5/8;";
 return features;
}
static BOOL ltrpDisabled(id self,SEL _cmd) { return NO; }
static void disableLTRPGetter(const char *className) {
 Method m=class_getInstanceMethod(NSClassFromString(@(className)),@selector(ltrpEnabled));
 if(!m) {NSLog(@"negotiator: %s has no ltrpEnabled",className);return;}
 method_setImplementation(m,(IMP)ltrpDisabled);
}
static BOOL installNegotiatorHooks(void) {
 static dispatch_once_t once;
 static BOOL installed=NO;
 dispatch_once(&once,^{
  Class settings=NSClassFromString(@"AVCMediaStreamNegotiatorSettingsCoreDeviceScreenSharing");
  Method features=class_getInstanceMethod(settings,@selector(featureListString));
  if(!features) {NSLog(@"negotiator: HEVC capability setting unavailable");return;}
  originalScreenFeatures=method_setImplementation(features,(IMP)screenDecoderFeatures);
  installed=YES;
  NSLog(@"negotiator: standalone-decoder HEVC capabilities enabled");
  if(getenv("KEEP_LTRP")) {NSLog(@"negotiator: KEEP_LTRP set, leaving LTRP enabled");return;}
  // The offer is built inside -initWithMode:options:error: from the settings preset
  // (AVCMediaStreamNegotiatorSettingsCoreDeviceScreenSharing) and the local configuration,
  // so both getters are overridden before the negotiator is created.
  disableLTRPGetter("AVCMediaStreamNegotiatorSettings");
  disableLTRPGetter("VCMediaNegotiatorLocalConfiguration");
  NSLog(@"negotiator: LTRP disabled for the offer");
 });
 return installed;
}
NSObject *probeNegotiator(NSDictionary *options, NSInteger mode) {
 dlopen("/System/Library/PrivateFrameworks/AVConference.framework/AVConference",RTLD_NOW);
 if(!installNegotiatorHooks()) return nil;
 NSError *e=nil; id n=[(NSObject*)[NSClassFromString(@"AVCMediaStreamNegotiator") alloc] initWithMode:mode options:options error:&e];
 if(e) NSLog(@"negotiator error: %@",e); return n;
}
NSData *probeOffer(NSObject *n){ id o=[n offer]; NSLog(@"offer class=%@",[o class]); return [o isKindOfClass:NSData.class]?o:nil; }
NSDictionary *probeAnswer(NSObject*n,NSData*a){NSError*e=nil; if(![n setAnswer:a withError:&e]){NSLog(@"answer error: %@",e);return nil;}id c=[n generateMediaStreamConfigurationWithError:&e]; if(e)NSLog(@"config error: %@",e);return [c dictionary];}

#import <sys/socket.h>
#import <netinet/in.h>
#import <arpa/inet.h>
#import <poll.h>
#import <unistd.h>
static int rx=-1;
static unsigned short rxPort=0;
NSString *probeBind(NSString *remoteIP) {
 int route=socket(AF_INET6,SOCK_DGRAM,0); struct sockaddr_in6 dst={0},src={0}; dst.sin6_len=sizeof(dst);dst.sin6_family=AF_INET6;dst.sin6_port=htons(9);
 if(inet_pton(AF_INET6,remoteIP.UTF8String,&dst.sin6_addr)!=1){close(route);return nil;}
 if(connect(route,(struct sockaddr*)&dst,sizeof(dst))!=0){perror("route connect");close(route);return nil;}
 socklen_t len=sizeof(src);getsockname(route,(struct sockaddr*)&src,&len);close(route);
 char ip[INET6_ADDRSTRLEN];inet_ntop(AF_INET6,&src.sin6_addr,ip,sizeof(ip));
 rx=socket(AF_INET6,SOCK_DGRAM,0);src.sin6_port=0;
 if(bind(rx,(struct sockaddr*)&src,sizeof(src))!=0){perror("receiver bind");probeClose();return nil;}
 len=sizeof(src);getsockname(rx,(struct sockaddr*)&src,&len);rxPort=ntohs(src.sin6_port);
 int sz=4*1024*1024;setsockopt(rx,SOL_SOCKET,SO_RCVBUF,&sz,sizeof(sz));return @(ip);
}
unsigned short probePort(void){return rxPort;}
NSData *probeReceive(int milliseconds){struct pollfd p={rx,POLLIN,0};if(poll(&p,1,milliseconds)<=0)return nil;unsigned char b[65536];ssize_t n=recv(rx,b,sizeof(b),0);return n>0?[NSData dataWithBytes:b length:n]:nil;}
void probeClose(void){if(rx>=0)close(rx);rx=-1;}

void probeAdopt(xpc_object_t sockets){char*d=xpc_copy_description(sockets);fprintf(stderr,"SOCKETS %s\n",d);free(d);xpc_dictionary_apply(sockets,^bool(const char*k,xpc_object_t v){if(xpc_get_type(v)==XPC_TYPE_FD){int fd=xpc_fd_dup(v);int t=0;socklen_t n=sizeof(t);getsockopt(fd,SOL_SOCKET,SO_TYPE,&t,&n);fprintf(stderr,"FD key=%s type=%d\n",k,t);if(rx<0){rx=fd;int sz=4*1024*1024;setsockopt(rx,SOL_SOCKET,SO_RCVBUF,&sz,sizeof(sz));}else close(fd);}return true;});}

BOOL probeSend(NSData *packet) { return send(rx, packet.bytes, packet.length, 0) == (ssize_t)packet.length; }
