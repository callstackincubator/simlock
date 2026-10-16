#import <Foundation/Foundation.h>
NSObject * _Nullable probeNegotiator(NSDictionary * _Nonnull options, NSInteger mode);
NSData * _Nullable probeOffer(NSObject * _Nonnull negotiator);
NSDictionary * _Nullable probeAnswer(NSObject * _Nonnull negotiator, NSData * _Nonnull answer);

NSString * _Nullable probeBind(NSString * _Nonnull remoteIP);
unsigned short probePort(void);
NSData * _Nullable probeReceive(int milliseconds);
void probeClose(void);



#import <xpc/xpc.h>
void probeAdopt(xpc_object_t _Nonnull sockets);

BOOL probeSend(NSData * _Nonnull packet);
